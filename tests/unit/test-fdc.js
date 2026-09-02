import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { discFor, guessDiscTypeFromName, localDisc } from "../../src/fdc.js";
import { Disc, DiscConfig, DiscLayout, loadSsd } from "../../src/disc.js";
import { IntelFdc } from "../../src/intel-fdc.js";
import { Scheduler } from "../../src/scheduler.js";
import { fake6502 } from "../../src/fake6502.js";

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

describe("loading a disc image", () => {
    // Every load says what it made of the image.
    beforeEach(() => vi.spyOn(globalThis.console, "log").mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it("lays a 40 track image out for a 40 track drive", () => {
        expect(discFor("test.ssd", catalogued(400)).is40Track).toBe(true);
        expect(discFor("test.ssd", catalogued(800)).is40Track).toBe(false);
    });

    it("does as it is told when a snapshot says how the disc was laid out", () => {
        expect(discFor("test.ssd", catalogued(400), null, DiscLayout.contiguous).is40Track).toBe(false);
        expect(discFor("test.ssd", catalogued(800), null, DiscLayout.expanded40).is40Track).toBe(true);
    });

    it("knows which formats hold a catalogue name", () => {
        expect(guessDiscTypeFromName("test.ssd").supportsCatalogue).toBe(true);
        expect(guessDiscTypeFromName("test.dsd").supportsCatalogue).toBe(true);
        // Naming one of these would call a setter it does not have.
        for (const name of ["test.adf", "test.adl", "test.hfe"])
            expect(guessDiscTypeFromName(name).supportsCatalogue).toBe(false);
    });

    it("has nothing to go on for a format that cannot say", () => {
        expect(guessDiscTypeFromName("test.adf").sniffLayout(new Uint8Array(80 * 16 * SectorSize))).toBe(null);
    });
});

describe("knowing whether a disc keeps its changes", () => {
    beforeEach(() => vi.spyOn(globalThis.console, "log").mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it("says no for a disc loaded without anywhere to write back to", () => {
        expect(discFor("test.ssd", catalogued(800), undefined, DiscLayout.contiguous).savesChanges).toBe(false);
    });

    it("says yes once a writeback is wired up", () => {
        expect(discFor("test.ssd", catalogued(800), () => {}, DiscLayout.contiguous).savesChanges).toBe(true);
    });

    it("says no for the ADFS formats, which discard the writeback they are handed", () => {
        const adfsImage = new Uint8Array(80 * 16 * SectorSize);
        for (const name of ["test.adf", "test.adl"])
            expect(discFor(name, adfsImage, () => {}, DiscLayout.contiguous).savesChanges).toBe(false);
    });
});

describe("a disc held in browser local storage", () => {
    const stubStorage = (localStorage) => vi.stubGlobal("window", { localStorage });

    const writeTrack = (created, trackNum) => {
        created.writePulses(false, trackNum, 0, 0);
        created.flushWrites();
    };

    beforeEach(() => vi.spyOn(globalThis.console, "log").mockImplementation(() => {}));
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("keeps its changes", () => {
        const stored = {};
        stubStorage({ setItem: (key, value) => (stored[key] = value) });

        const created = localDisc("kept.ssd", DiscLayout.contiguous);
        writeTrack(created, 0);

        expect(created.savesChanges).toBe(true);
        expect(stored["disc_kept.ssd"]).toBeTypeOf("string");
    });

    it("reports a refused write once however many tracks are written", () => {
        const refusal = new Error("QuotaExceededError");
        stubStorage({
            setItem: () => {
                throw refusal;
            },
        });
        const refused = [];

        const created = localDisc("full.ssd", DiscLayout.contiguous, (error) => refused.push(error));
        for (const trackNum of [0, 1, 2]) writeTrack(created, trackNum);

        expect(refused).toEqual([refusal]);
    });

    it("says nothing while the writes are being stored", () => {
        stubStorage({ setItem: () => {} });
        let refusals = 0;

        writeTrack(
            localDisc("fine.ssd", DiscLayout.contiguous, () => refusals++),
            0,
        );

        expect(refusals).toBe(0);
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
