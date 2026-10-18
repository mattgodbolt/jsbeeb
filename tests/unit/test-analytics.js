// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsLocation } from "../../src/web/analytics.js";
import { Parameters } from "../../src/web/parameters.js";

describe("analytics", () => {
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

        it("names each ROM on its own", () => {
            expect(analyticsLocation(`${base}?rom=https%3A%2F%2Fexample.com%2Fa.rom&rom=file:mine.rom`)).toBe(
                `${base}?rom=https://example.com/a.rom&rom=file`,
            );
        });

        it("redacts the room and the name of a shared session", () => {
            expect(analyticsLocation(`${base}?client=room-key&name=Someone&model=B`)).toBe(
                `${base}?client=redacted&name=redacted&model=B`,
            );
            expect(analyticsLocation(`${base}?server=room-key`)).toBe(`${base}?server=redacted`);
        });

        it.each(Object.entries(Parameters).filter(([, { analyticsFilter }]) => analyticsFilter))(
            "puts %s through its own analyticsFilter",
            (name, { analyticsFilter }) => {
                const value = "gd:1AbC/Mine.ssd";
                expect(analyticsLocation(`${base}?${name}=${value}`)).toBe(`${base}?${name}=${analyticsFilter(value)}`);
            },
        );

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
                const { configureAnalytics, noteLocation, noteEvent, UrlState } = await loadWithMeasurementId("");
                configureAnalytics();
                noteLocation();
                noteEvent("category", "type", "label");
                new UrlState(window.location, window.history).set({ disc1: "local:Mine" });
                expect(gtag).not.toHaveBeenCalled();
            });
        });

        describe("with a measurement id", () => {
            const measurementId = "G-UNITTEST";

            it("sends nothing without gtag on the page", async () => {
                vi.stubGlobal("gtag", undefined);
                const { configureAnalytics, noteEvent } = await loadWithMeasurementId(measurementId);
                expect(() => {
                    configureAnalytics();
                    noteEvent("category", "type", "label");
                }).not.toThrow();
            });

            it("configures the page_view with the location and referrer analyticsLocation gives", async () => {
                const { configureAnalytics } = await loadWithMeasurementId(measurementId);
                window.history.replaceState(null, "", "/?disc1=local:Mine&model=B");
                configureAnalytics();
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

            it("sends events from any host", async () => {
                const { noteEvent } = await loadWithMeasurementId(measurementId);
                noteEvent("category", "type", "label");
                expect(gtag).toHaveBeenCalledWith("event", "category", { type: "type", label: "label" });
            });
        });
    });
});
