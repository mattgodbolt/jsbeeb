// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsLocation, configureAnalytics, mediaLabel, noteLocation } from "../../src/web/analytics.js";
import { Sources } from "../../src/web/media-catalogue.js";
import { Schemas } from "../../src/media-resolver.js";
import { Parameters } from "../../src/web/parameters.js";
import { UrlState } from "../../src/web/url-state.js";

describe("analytics", () => {
    describe("mediaLabel", () => {
        it.each([
            "elite.ssd",
            "sth:Acornsoft/Elite.zip",
            "|Acornsoft/Elite.zip",
            "hfe:Elite.hfe",
            "bitshifters:bs-paradroid.ssd",
            "github:someone/discs@v1/game.ssd",
            "https://example.com/game.ssd",
            "http://example.com/game.ssd",
            "unknown:thing.ssd",
        ])("keeps %s whole", (ref) => {
            expect(mediaLabel(ref)).toBe(ref);
        });

        it.each([
            ["gd:1AbCdEf/My Disc.ssd", "gdrive"],
            ["local:My Disc", "browser"],
            ["!My Disc", "browser"],
            ["session:3/mine.ssd", "session"],
            ["data:application/binary;base64,AAAA", "data"],
            ["b64data:AAAA", "b64data"],
            ["file:///home/someone/mine.ssd", "file"],
        ])("names %s only by its source", (ref, label) => {
            expect(mediaLabel(ref)).toBe(label);
        });

        it.each(Object.entries(Schemas).filter(([schema, { source }]) => schema && Sources[source]?.personal))(
            "names a %s: reference by its personal source",
            (schema, { source }) => {
                expect(mediaLabel(`${schema}${schema.length > 1 ? ":" : ""}mine`)).toBe(source);
            },
        );

        it("leaves nothing as nothing", () => {
            expect(mediaLabel(undefined)).toBeUndefined();
        });
    });

    describe("analyticsLocation", () => {
        const base = "https://bbc.xania.org/";

        it("leaves a URL naming public media as it is", () => {
            const href = `${base}?disc=elite.ssd&tape=sth:Acornsoft/Elite.zip&disc2=sth%3AAcornsoft%2FElite.zip&model=Master&autoboot`;
            expect(analyticsLocation(href)).toBe(href);
        });

        it("names the user's own media only by its source, in the query and after the hash", () => {
            expect(
                analyticsLocation(
                    `${base}?disc1=gd%3A1AbC%2FMy%20Disc.ssd&disc2=local:Mine&model=B#tape=!Tape&autoboot`,
                ),
            ).toBe(`${base}?disc1=gdrive&disc2=browser&model=B#tape=browser&autoboot`);
        });

        it("names each ROM on its own", () => {
            expect(analyticsLocation(`${base}?rom=https%3A%2F%2Fexample.com%2Fa.rom&rom=file:mine.rom`)).toBe(
                `${base}?rom=https%3A%2F%2Fexample.com%2Fa.rom&rom=file`,
            );
        });

        it("redacts the room and the name of a shared session", () => {
            expect(analyticsLocation(`${base}?client=room-key&name=Someone&model=B`)).toBe(
                `${base}?client=redacted&name=redacted&model=B`,
            );
            expect(analyticsLocation(`${base}?server=room-key`)).toBe(`${base}?server=redacted`);
        });

        it.each(Object.keys(Parameters).filter((name) => Parameters[name].personal))("redacts %s", (name) => {
            expect(analyticsLocation(`${base}?${name}=mine`)).toBe(`${base}?${name}=redacted`);
        });

        it.each(Object.keys(Parameters).filter((name) => Parameters[name].mediaRef))(
            "names a Drive file in %s only by its source",
            (name) => {
                expect(analyticsLocation(`${base}?${name}=gd:1AbC/Mine.ssd`)).toBe(`${base}?${name}=gdrive`);
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

        beforeEach(() => {
            gtag = vi.fn();
            vi.stubGlobal("gtag", gtag);
            vi.spyOn(Document.prototype, "referrer", "get").mockReturnValue(
                "https://bbc.xania.org/?disc1=gd:1AbC/Before.ssd&model=B",
            );
        });

        afterEach(() => {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
            window.history.replaceState(null, "", "/");
        });

        it("configures the page_view with the location and referrer analyticsLocation gives", () => {
            window.history.replaceState(null, "", "/?disc1=local:Mine&model=B");
            configureAnalytics();
            expect(gtag).toHaveBeenCalledWith("config", expect.any(String), {
                page_location: `${origin()}/?disc1=browser&model=B`,
                page_referrer: "https://bbc.xania.org/?disc1=gdrive&model=B",
            });
        });

        it("moves the location later events report without another page_view", () => {
            window.history.replaceState(null, "", "/?disc1=gd:1AbC/Mine.ssd");
            noteLocation();
            expect(gtag).toHaveBeenCalledWith("config", expect.any(String), {
                page_location: `${origin()}/?disc1=gdrive`,
                page_referrer: "https://bbc.xania.org/?disc1=gdrive&model=B",
                send_page_view: false,
            });
        });

        it("moves the location each time the page pushes its URL", () => {
            const state = new UrlState(window.location, window.history);
            state.set({ disc1: "local:Mine" });
            expect(gtag).toHaveBeenLastCalledWith(
                "config",
                expect.any(String),
                expect.objectContaining({ page_location: `${origin()}/?disc1=browser` }),
            );
        });
    });
});
