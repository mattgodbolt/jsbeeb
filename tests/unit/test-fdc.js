import { describe, it, expect } from "vitest";

import { loadDiscInto } from "../../src/fdc.js";
import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Scheduler } from "../../src/scheduler.js";

const SectorSize = 256;
const SectorsPerTrack = 10;

function ssdDisc(numTracks, is40Track) {
    const config = new DiscConfig();
    config.expandTo80 = is40Track;
    const data = new Uint8Array(numTracks * SectorsPerTrack * SectorSize);
    return loadSsd(new Disc(true, config, "test.ssd"), data, false, null);
}

/** Enough of an FDC to take a disc: the drives, and somewhere to put one. */
function fakeFdc() {
    const scheduler = new Scheduler();
    const drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];
    return { drives, loadDisc: (driveIndex, disc) => drives[driveIndex].setDisc(disc) };
}

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
