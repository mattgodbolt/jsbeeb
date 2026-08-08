import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { discFor, guessDiscTypeFromName } from "../../src/fdc.js";
import { DiscLayout } from "../../src/disc.js";

const SectorSize = 256;
const SectorsPerTrack = 10;
const TrackSize = SectorSize * SectorsPerTrack;

/** An image with a DFS catalogue claiming a disc of `sectors` sectors and holding no files. */
function catalogued(sectors, length = 80 * TrackSize) {
    const data = new Uint8Array(length);
    data[0x106] = (sectors >>> 8) & 3;
    data[0x107] = sectors & 0xff;
    return data;
}

describe("loading a disc image", () => {
    // Every load says what it made of the image.
    beforeEach(() => vi.spyOn(globalThis.console, "log").mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it("lays a 40 track image out for a 40 track drive", () => {
        expect(discFor(null, "test.ssd", catalogued(400)).is40Track).toBe(true);
        expect(discFor(null, "test.ssd", catalogued(800)).is40Track).toBe(false);
    });

    it("does as it is told when a snapshot says how the disc was laid out", () => {
        expect(discFor(null, "test.ssd", catalogued(400), null, DiscLayout.contiguous).is40Track).toBe(false);
        expect(discFor(null, "test.ssd", catalogued(800), null, DiscLayout.expanded40).is40Track).toBe(true);
    });

    it("has nothing to go on for a format that cannot say", () => {
        expect(guessDiscTypeFromName("test.adf").sniffLayout(new Uint8Array(80 * 16 * SectorSize))).toBe(null);
    });
});
