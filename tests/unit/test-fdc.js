import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

import { discFor, guessDiscTypeFromName } from "../../src/fdc.js";
import { Disc, DiscConfig, DiscLayout, loadSsd } from "../../src/disc.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { Scheduler } from "../../src/scheduler.js";
import { fake6502 } from "../../src/fake6502.js";
import { ssdImage } from "./helpers.js";
import { crc32 } from "../../src/archive.js";

const SectorSize = 256;
const SectorsPerTrack = 10;
const TrackSize = SectorSize * SectorsPerTrack;

function ssdDisc(numTracks, is40Track) {
    const config = new DiscConfig();
    config.expandTo80 = is40Track;
    const data = new Uint8Array(numTracks * TrackSize);
    return loadSsd(new Disc(true, config, "test.ssd"), data, false, null);
}

describe("loading a disc image", () => {
    it("keeps only the CRC of the image it loaded", () => {
        const image = ssdImage();
        const disc = discFor("test.ssd", image);
        expect(disc.originalImageCrc32).toBe(crc32(image));
        expect(disc.originalImageData).toBeNull();
    });

    it("lays a 40 track image out for a 40 track drive, and notes why", () => {
        const forty = discFor("test.ssd", ssdImage(400));
        expect(forty.is40Track).toBe(true);
        expect(forty.loadNotes).toEqual([{ text: expect.stringMatching(/^40 track, as /), isOdd: false }]);
        expect(discFor("test.ssd", ssdImage(800)).is40Track).toBe(false);
    });

    it(
        "notes what a flux image's surface says of its layout ahead of the image's own notes",
        { timeout: 30000 },
        () => {
            const elite = discFor("elite.hfe", fs.readFileSync("public/discs/elite.hfe"));
            expect(elite.is40Track).toBe(true);
            expect(elite.loadNotes.map(({ text }) => text)).toEqual([
                expect.stringMatching(/^40 track, as \d+ tracks sit at twice the number their sectors claim$/),
                "HFE v3, 2 sides, 81 tracks",
            ]);
        },
    );

    it("does as it is told when a snapshot says how the disc was laid out, with nothing to note", () => {
        const told = discFor("test.ssd", ssdImage(400), null, DiscLayout.contiguous);
        expect(told.is40Track).toBe(false);
        expect(told.loadNotes).toEqual([]);
        expect(discFor("test.ssd", ssdImage(800), null, DiscLayout.expanded40).is40Track).toBe(true);
    });

    it("knows which formats hold a catalogue name", () => {
        expect(guessDiscTypeFromName("test.ssd").setDiscName).not.toBeNull();
        expect(guessDiscTypeFromName("test.dsd").setDiscName).not.toBeNull();
        for (const name of ["test.adf", "test.adl", "test.hfe"])
            expect(guessDiscTypeFromName(name).setDiscName).toBeNull();
    });
});

describe("knowing whether a disc keeps its changes", () => {
    const adfsImage = new Uint8Array(80 * 16 * SectorSize);

    it.each([
        ["no for a disc loaded without anywhere to write back to", "test.ssd", ssdImage(800), undefined, false],
        ["yes once a writeback is wired up", "test.ssd", ssdImage(800), () => {}, true],
        ["no for ADFS, which discards the writeback it is handed", "test.adf", adfsImage, () => {}, false],
        ["no for ADFS large, which discards the writeback it is handed", "test.adl", adfsImage, () => {}, false],
    ])("says %s", (_, name, image, onChange, expected) => {
        expect(discFor(name, image, onChange, DiscLayout.contiguous).savesChanges).toBe(expected);
    });
});

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
