import { describe, it, expect } from "vitest";

import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { Scheduler } from "../../src/scheduler.js";
import { fake6502 } from "../../src/fake6502.js";

const SectorSize = 256;
const SectorsPerTrack = 10;

function ssdDisc(numTracks, is40Track) {
    const config = new DiscConfig();
    config.expandTo80 = is40Track;
    const data = new Uint8Array(numTracks * SectorsPerTrack * SectorSize);
    return loadSsd(new Disc(true, config, "test.ssd"), data, false, null);
}

describe("putting a disc in a drive", () => {
    const newFdc = () => new IntelFdc(fake6502(), new Scheduler());

    it("sets the drive's switch to suit the disc", () => {
        const fdc = newFdc();

        fdc.loadDisc(1, ssdDisc(40, true));

        expect(fdc.drives[1].tracksPerStep).toBe(2);
        expect(fdc.drives[0].tracksPerStep).toBe(1);
    });

    it("puts the switch back for the next 80 track disc", () => {
        const fdc = newFdc();

        fdc.loadDisc(0, ssdDisc(40, true));
        fdc.loadDisc(0, ssdDisc(80, false));

        expect(fdc.drives[0].tracksPerStep).toBe(1);
    });

    it("leaves the switch where the caller asks for it", () => {
        const fdc = newFdc();

        fdc.loadDisc(0, ssdDisc(40, true), 1);
        fdc.loadDisc(1, ssdDisc(80, false), 2);

        expect(fdc.drives[0].tracksPerStep).toBe(1);
        expect(fdc.drives[1].tracksPerStep).toBe(2);
    });
});
