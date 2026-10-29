// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsLocation } from "../../src/web/analytics.js";
import { Parameters } from "../../src/web/parameters.js";
import { stitchHtml } from "../../tools/html-includes.js";

describe("analytics", () => {
    describe("the features index.html declares", () => {
        const page = new DOMParser().parseFromString(stitchHtml("index.html"), "text/html");
        const features = [...page.querySelectorAll("[data-feature]")].map((el) => el.dataset.feature);

        it("are each declared once", () => {
            expect(features.length).toBeGreaterThan(0);
            expect(new Set(features).size).toBe(features.length);
        });

        it("puts the State menu's items inside its declaration", () => {
            expect(page.getElementById("save-state").closest("[data-feature]").dataset.feature).toBe("state");
            expect(page.getElementById("load-state").closest("[data-feature]").dataset.feature).toBe("state");
        });

        it.each(features)("names %s in snake_case", (feature) => {
            expect(feature).toMatch(/^[a-z]+(_[a-z]+)*$/);
        });
    });

    describe("analyticsLocation", () => {
        const base = "https://bbc.xania.org/";

        it("leaves a URL naming public media as it is", () => {
            const href = `${base}?disc=elite.ssd&tape=sth:Acornsoft/Elite.zip&model=Master&autoboot`;
            expect(analyticsLocation(href)).toBe(href);
        });

        it("writes the URL as the page writes its own", () => {
            expect(analyticsLocation(`${base}?disc2=sth%3AAcornsoft%2FElite.zip`)).toBe(
                `${base}?disc2=sth:Acornsoft/Elite.zip`,
            );
        });

        it("names the user's own media only by its source, from the query and after the hash", () => {
            expect(
                analyticsLocation(
                    `${base}?disc1=gd%3A1AbC%2FMy%20Disc.ssd&disc2=local:Mine&model=B#tape=!Tape&autoboot`,
                ),
            ).toBe(`${base}?disc1=gdrive&disc2=browser&model=B&tape=browser&autoboot`);
        });

        it("names each ROM on its own, whichever bank it goes in", () => {
            expect(
                analyticsLocation(
                    `${base}?rom=https%3A%2F%2Fexample.com%2Fa.rom&rom=file:mine.rom&rom.7=github:o/r/x.rom&ROM.8=file:b.rom`,
                ),
            ).toBe(`${base}?rom=https://example.com/a.rom&rom=file&rom.7=github:o/r/x.rom&ROM.8=file`);
        });

        it("redacts what the URL would have typed or run", () => {
            expect(analyticsLocation(`${base}?autotype=my%20secret&embedBasic=10%20PRINT&patch=1234:ea`)).toBe(
                `${base}?autotype=redacted&embedBasic=redacted&patch=redacted`,
            );
        });

        it("redacts the room and the name of a shared session", () => {
            expect(analyticsLocation(`${base}?client=room-key&name=Someone&model=B`)).toBe(
                `${base}?client=redacted&name=redacted&model=B`,
            );
            expect(analyticsLocation(`${base}?server=room-key`)).toBe(`${base}?server=redacted`);
        });

        it.each(Object.entries(Parameters).filter(([, { analyticsFilter, prefix }]) => analyticsFilter && !prefix))(
            "puts %s through its own analyticsFilter",
            (name, { analyticsFilter }) => {
                const value = "gd:1AbC/Mine.ssd";
                expect(analyticsLocation(`${base}?${name}=${value}`)).toBe(`${base}?${name}=${analyticsFilter(value)}`);
            },
        );

        it("leaves the key and gamepad mappings as they are", () => {
            const href = `${base}?KEY.CAPSLOCK=CTRL&key.f1=COPY&GP.FIRE2=RETURN&gp.fire1=SPACE&FIRE=SPACE`;
            expect(analyticsLocation(href)).toBe(href);
        });

        it("leaves a parameter the page does not know as it is", () => {
            const href = `${base}?utm_source=somewhere&constructor=gd:1AbC/Mine.ssd`;
            expect(analyticsLocation(href)).toBe(href);
        });

        it("keeps no parameters at all from a URL whose parameters cannot be decoded", () => {
            expect(analyticsLocation(`${base}?disc1=gd:1AbC/Mine%E0.ssd&model=B`)).toBe(base);
        });

        it("leaves an empty referrer empty", () => {
            expect(analyticsLocation("")).toBe("");
        });
    });

    describe("gtag", () => {
        let gtag;
        const origin = () => window.location.origin;

        const loadWithMeasurementId = async (measurementId) => {
            vi.stubEnv("GA_MEASUREMENT_ID", measurementId);
            vi.resetModules();
            return {
                ...(await import("../../src/web/analytics.js")),
                ...(await import("../../src/web/url-state.js")),
            };
        };

        beforeEach(() => {
            gtag = vi.fn();
            vi.stubGlobal("gtag", gtag);
            vi.spyOn(console, "log").mockImplementation(() => {});
            vi.spyOn(Document.prototype, "referrer", "get").mockReturnValue(
                "https://bbc.xania.org/?disc1=gd:1AbC/Before.ssd&model=B",
            );
        });

        afterEach(() => {
            vi.unstubAllEnvs();
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
            window.history.replaceState(null, "", "/");
        });

        describe("without a measurement id", () => {
            it("sends nothing, even with gtag on the page", async () => {
                const { configureAnalytics, noteLocation, note, noteFeature, noteError, UrlState } =
                    await loadWithMeasurementId("");
                const page = new EventTarget();
                configureAnalytics(page);
                noteLocation();
                note("event", { type: "type" });
                noteFeature("printer", "open");
                noteError("loop", new Error("broken"));
                page.dispatchEvent(new ErrorEvent("error", { message: "broken" }));
                new UrlState(window.location, window.history).set({ disc1: "local:Mine" });
                expect(gtag).not.toHaveBeenCalled();
            });
        });

        describe("with a measurement id", () => {
            const measurementId = "G-UNITTEST";

            it("sends nothing without gtag on the page", async () => {
                vi.stubGlobal("gtag", undefined);
                const { configureAnalytics, note } = await loadWithMeasurementId(measurementId);
                expect(() => {
                    configureAnalytics(new EventTarget());
                    note("event", { type: "type" });
                }).not.toThrow();
            });

            it("sends nothing once silenced", async () => {
                const { configureAnalytics, silenceAnalytics, noteLocation, note, noteFeature, noteError } =
                    await loadWithMeasurementId(measurementId);
                silenceAnalytics();
                configureAnalytics(new EventTarget());
                noteLocation();
                note("event", { type: "type" });
                noteFeature("printer", "open");
                noteError("loop", new Error("broken"));
                expect(gtag).not.toHaveBeenCalled();
            });

            it("configures the page_view with the location and referrer analyticsLocation gives", async () => {
                const { configureAnalytics } = await loadWithMeasurementId(measurementId);
                window.history.replaceState(null, "", "/?disc1=local:Mine&model=B");
                configureAnalytics(new EventTarget());
                expect(gtag).toHaveBeenCalledWith("config", measurementId, {
                    page_location: `${origin()}/?disc1=browser&model=B`,
                    page_referrer: "https://bbc.xania.org/?disc1=gdrive&model=B",
                });
            });

            it("moves the location later events report without another page_view", async () => {
                const { noteLocation } = await loadWithMeasurementId(measurementId);
                window.history.replaceState(null, "", "/?disc1=gd:1AbC/Mine.ssd");
                noteLocation();
                expect(gtag).toHaveBeenCalledWith("config", measurementId, {
                    page_location: `${origin()}/?disc1=gdrive`,
                    page_referrer: "https://bbc.xania.org/?disc1=gdrive&model=B",
                    send_page_view: false,
                });
            });

            it("moves the location each time the page pushes its URL", async () => {
                const { UrlState } = await loadWithMeasurementId(measurementId);
                new UrlState(window.location, window.history).set({ disc1: "local:Mine" });
                expect(gtag).toHaveBeenLastCalledWith(
                    "config",
                    measurementId,
                    expect.objectContaining({ page_location: `${origin()}/?disc1=browser` }),
                );
            });

            it("sends events from any host, leaving out the parameters that are undefined", async () => {
                const { note } = await loadWithMeasurementId(measurementId);
                note("category", { type: "type", label: undefined, count: 0 });
                expect(gtag).toHaveBeenCalledWith("event", "category", { type: "type", count: 0 });
            });

            it("logs what it sends as one line of text, leaving out the parameters that are undefined", async () => {
                const { note } = await loadWithMeasurementId(measurementId);
                note("category", { type: "type", label: undefined, count: 0, embed: false });
                expect(console.log).toHaveBeenCalledWith("event noted: category type=type count=0 embed=false");
            });

            it.each([
                ["a b", '"a b"'],
                ['a"b', '"a\\"b"'],
                ["a=b", '"a=b"'],
                ["a\nb", '"a\\nb"'],
                ["", '""'],
            ])("quotes %j in the log line so it reads as one value", async (value, logged) => {
                const { note } = await loadWithMeasurementId(measurementId);
                note("category", { label: value });
                expect(console.log).toHaveBeenCalledWith(`event noted: category label=${logged}`);
            });

            const sent = (name) =>
                gtag.mock.calls.filter(([command, event]) => command === "event" && event === name).map(([, , p]) => p);

            describe("noteFeature", () => {
                afterEach(() => (document.body.innerHTML = ""));

                it("names the feature by the data-feature its element is or is inside", async () => {
                    const { noteFeature } = await loadWithMeasurementId(measurementId);
                    document.body.innerHTML = '<div data-feature="rewind"><button>x</button></div><p>none</p>';
                    noteFeature(document.querySelector("button"), "rewound");
                    noteFeature(document.querySelector("[data-feature]"), "open");
                    noteFeature(document.querySelector("p"), "open");
                    expect(sent("feature_used")).toEqual([
                        { feature: "rewind", action: "rewound" },
                        { feature: "rewind", action: "open" },
                    ]);
                });

                it("takes a feature by name where there is no element to declare it on", async () => {
                    const { noteFeature } = await loadWithMeasurementId(measurementId);
                    noteFeature("printer", "open");
                    expect(sent("feature_used")).toEqual([{ feature: "printer", action: "open" }]);
                });
            });

            describe("noteError", () => {
                it("cleans the message and finds where it happened from the stack", async () => {
                    const { noteError } = await loadWithMeasurementId(measurementId);
                    const error = new Error('Unable to load "Mine.ssd" from https://example.com/a?b=c');
                    error.stack = [
                        `Error: ${error.message}`,
                        "    at load (https://bbc.xania.org/assets/main-1a2b.js?v=3:12:345)",
                        "    at https://bbc.xania.org/assets/other.js:1:2",
                    ].join("\n");
                    noteError("loop", error);
                    const firefox = new Error("broken");
                    firefox.stack = "load@https://bbc.xania.org/assets/main-1a2b.js:7:8\n";
                    noteError("startup", firefox);
                    expect(sent("js_error")).toEqual([
                        {
                            where: "loop",
                            message: 'Unable to load "" from <address>',
                            file_line: "main-1a2b.js:12:345",
                        },
                        { where: "startup", message: "broken", file_line: "main-1a2b.js:7:8" },
                    ]);
                });

                it("notes an error once, however many places see it", async () => {
                    const { noteError } = await loadWithMeasurementId(measurementId);
                    const error = new Error("broken");
                    noteError("loop", error);
                    noteError("window", error);
                    expect(sent("js_error")).toHaveLength(1);
                });

                it("notes only the first ten errors a page has", async () => {
                    const { noteError } = await loadWithMeasurementId(measurementId);
                    for (let i = 0; i < 100; ++i) noteError("loop", new Error(`broken ${i}`));
                    expect(sent("js_error")).toHaveLength(10);
                    expect(sent("js_error").at(-1).message).toBe("broken 9");
                });

                it("notes what the window and unhandled rejections report once configured", async () => {
                    const { configureAnalytics } = await loadWithMeasurementId(measurementId);
                    const page = new EventTarget();
                    configureAnalytics(page);
                    page.dispatchEvent(
                        new ErrorEvent("error", {
                            message: "Uncaught TypeError: x is undefined",
                            filename: "https://bbc.xania.org/assets/main.js?v=1",
                            lineno: 3,
                            colno: 4,
                        }),
                    );
                    page.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
                    const rejection = new Event("unhandledrejection");
                    rejection.reason = "gone";
                    page.dispatchEvent(rejection);
                    expect(sent("js_error")).toEqual([
                        { where: "window", message: "Uncaught TypeError: x is undefined", file_line: "main.js:3:4" },
                        { where: "window", message: "Script error." },
                        { where: "promise", message: "gone" },
                    ]);
                });
            });

            describe("noteMachineStart", () => {
                it("sends each reportedAtStart parameter as it is set, with what the page found", async () => {
                    const { noteMachineStart } = await loadWithMeasurementId(measurementId);
                    const settings = { value: (name) => ({ model: "Master", keyLayout: "natural" })[name] };
                    await noteMachineStart(settings, { embed: true }, { boot_mode: "boot", renderer: "webgl" }, "ok");
                    await noteMachineStart(settings, {}, { boot_mode: "none" }, undefined);
                    expect(sent("machine_start")).toEqual([
                        {
                            model: "Master",
                            keyLayout: "natural",
                            embed: true,
                            boot_mode: "boot",
                            renderer: "webgl",
                            audio: "ok",
                        },
                        { model: "Master", keyLayout: "natural", embed: false, boot_mode: "none" },
                    ]);
                });

                it("waits for the sound, reporting the settings as they were when it was asked", async () => {
                    const { noteMachineStart } = await loadWithMeasurementId(measurementId);
                    const now = { model: "Master", keyLayout: "physical" };
                    let soundUp;
                    const noted = noteMachineStart(
                        { value: (name) => now[name] },
                        {},
                        { boot_mode: "none" },
                        new Promise((resolve) => (soundUp = resolve)),
                    );
                    now.keyLayout = "natural";
                    await Promise.resolve();
                    expect(sent("machine_start")).toEqual([]);
                    soundUp("unavailable");
                    await noted;
                    expect(sent("machine_start")).toEqual([
                        {
                            model: "Master",
                            keyLayout: "physical",
                            embed: false,
                            boot_mode: "none",
                            audio: "unavailable",
                        },
                    ]);
                });
            });
        });
    });
});
