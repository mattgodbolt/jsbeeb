import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { discFor, guessDiscTypeFromName, loadDiscInto } from "../../src/fdc.js";
import { Disc, DiscConfig, DiscLayout, loadSsd } from "../../src/disc.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Scheduler } from "../../src/scheduler.js";

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

function ssdDisc(numTracks, is40Track) {
    const config = new DiscConfig();
    config.expandTo80 = is40Track;
    const data = new Uint8Array(numTracks * TrackSize);
    return loadSsd(new Disc(true, config, "test.ssd"), data, false, null);
}

/** Enough of an FDC to take a disc: the drives, and somewhere to put one. */
function fakeFdc() {
    const scheduler = new Scheduler();
    const drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];
    return { drives, loadDisc: (driveIndex, disc) => drives[driveIndex].setDisc(disc) };
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

describe("putting a disc in a drive", () => {
    it("sets the drive's switch to suit the disc", () => {
        const fdc = fakeFdc();

        loadDiscInto(fdc, 1, ssdDisc(40, true));

        expect(fdc.drives[1].is40Track).toBe(true);
        expect(fdc.drives[0].is40Track).toBe(false);
    });

    it("puts the switch back for the next 80 track disc", () => {
        const fdc = fakeFdc();

        loadDiscInto(fdc, 0, ssdDisc(40, true));
        loadDiscInto(fdc, 0, ssdDisc(80, false));

        expect(fdc.drives[0].is40Track).toBe(false);
    });

    it("leaves the switch where the user fixed it", () => {
        const fdc = fakeFdc();

        loadDiscInto(fdc, 0, ssdDisc(40, true), false);
        loadDiscInto(fdc, 1, ssdDisc(80, false), true);

        expect(fdc.drives[0].is40Track).toBe(false);
        expect(fdc.drives[1].is40Track).toBe(true);
    });
});
