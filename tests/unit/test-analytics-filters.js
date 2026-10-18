import { describe, expect, it } from "vitest";

import { countBucket, errorLabel, mediaLabel, redacted, sourceKey } from "../../src/web/analytics-filters.js";
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

    describe("sourceKey", () => {
        it.each([
            ["elite.ssd", "builtin"],
            ["sth:Acornsoft/Elite.zip", "sth"],
            ["|Acornsoft/Elite.zip", "sth"],
            ["github:someone/discs@v1/game.ssd", "github"],
            ["gd:1AbCdEf/My Disc.ssd", "gdrive"],
            ["!My Disc", "browser"],
            ["https://example.com/game.ssd", "https"],
            ["data:application/binary;base64,AAAA", "data"],
            ["file:///home/someone/mine.ssd", "file"],
        ])("says %s comes from %s", (ref, source) => {
            expect(sourceKey(ref)).toBe(source);
        });

        it.each(Object.entries(Schemas).filter(([schema]) => schema))(
            "gives a %s: reference a Sources key or its own schema",
            (schema, { source }) => {
                const key = sourceKey(`${schema}${schema.length > 1 ? ":" : ""}x`);
                expect(source ? Object.keys(Sources) : [schema]).toContain(key);
            },
        );
    });

    describe("errorLabel", () => {
        it("takes out quoted text and addresses", () => {
            expect(
                errorLabel(`Unable to load "My Disc.ssd" from https://example.com/x.ssd?k=1, 'mine' and \`this\``),
            ).toBe('Unable to load "" from <address> "" and ""');
        });

        it("takes out data and file addresses", () => {
            expect(errorLabel("bad data:AAAA and file:///home/me/x.ssd")).toBe("bad <address> and <address>");
        });

        it("cuts a long message to GA's parameter limit", () => {
            expect(errorLabel("x".repeat(500))).toHaveLength(100);
        });

        it("tells what was thrown when it was not an error", () => {
            expect(errorLabel(undefined)).toBe("undefined");
        });
    });

    describe("countBucket", () => {
        it.each([
            [0, "0"],
            [1, "1"],
            [2, "2"],
            [3, "3-4"],
            [4, "3-4"],
            [5, "5+"],
            [40, "5+"],
        ])("puts %i in %s", (count, bucket) => {
            expect(countBucket(count)).toBe(bucket);
        });
    });

    describe("redacted", () => {
        it("tells nothing of the value", () => {
            expect(redacted("room-key")).toBe("redacted");
        });
    });
});
