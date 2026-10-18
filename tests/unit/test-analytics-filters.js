import { describe, expect, it } from "vitest";

import { mediaLabel, redacted } from "../../src/web/analytics-filters.js";
import { Sources } from "../../src/web/media-catalogue.js";
import { Schemas } from "../../src/media-resolver.js";

describe("analytics filters", () => {
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

        it.each(Object.entries(Schemas).filter(([, { source, personal }]) => !source && personal))(
            "names a %s: reference by its schema alone",
            (schema) => {
                expect(mediaLabel(`${schema}:mine`)).toBe(schema);
            },
        );

        it("leaves nothing as nothing", () => {
            expect(mediaLabel(undefined)).toBeUndefined();
        });
    });

    describe("redacted", () => {
        it("tells nothing of the value", () => {
            expect(redacted("room-key")).toBe("redacted");
        });
    });
});
