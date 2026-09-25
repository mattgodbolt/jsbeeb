import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootOne } from "../../tools/registry/boot-survey.js";
import {
    junkDfsTitle,
    knownTitle,
    machineClaims,
    titleWords,
    verdict,
} from "../../tools/registry/boot-survey-analyse.js";

const SectorSize = 256;
const BootOptionExec = 3;
const TotalSectors = 400;

function ssdWithBoot(bootText) {
    const disc = Buffer.alloc(TotalSectors * SectorSize);
    const boot = Buffer.from(bootText.replace(/\n/g, "\r"), "latin1");
    disc.write("BOOTTEST", 0, "latin1");
    disc.write("!BOOT  $", 8, "latin1");
    disc[SectorSize + 5] = 8;
    disc[SectorSize + 6] = (BootOptionExec << 4) | (TotalSectors >> 8);
    disc[SectorSize + 7] = TotalSectors & 0xff;
    disc.writeUInt16LE(boot.length, SectorSize + 8 + 4);
    disc[SectorSize + 8 + 7] = 2;
    boot.copy(disc, 2 * SectorSize);
    return disc;
}

describe("boot survey", () => {
    let corpus;
    beforeAll(() => {
        corpus = mkdtempSync(path.join(tmpdir(), "boot-survey-"));
        writeFileSync(
            path.join(corpus, "loop.ssd"),
            ssdWithBoot('MODE 7\nPRINT "HELLO TELETEXT"\nREPEAT UNTIL FALSE\n'),
        );
        writeFileSync(path.join(corpus, "mode4.ssd"), ssdWithBoot('MODE 4\nPRINT "HELLO BITMAP"\n'));
        writeFileSync(path.join(corpus, "error.ssd"), ssdWithBoot("*NOPE\n"));
    });
    afterAll(() => rmSync(corpus, { recursive: true, force: true }));

    const boot = (ref, model = "B-DFS1.2") => bootOne({ ref }, model, { corpus, seconds: 6, shotPath: null });

    it("sees a BASIC program still running, and reads teletext from screen memory", async () => {
        const result = await boot("loop.ssd");
        expect(result.state).toBe("running-basic");
        expect(result.teletext).toBe(true);
        expect(result.screenText).toContain("HELLO TELETEXT");
    });

    it("reads text in a bitmap mode by matching the MOS font, and sees the prompt", async () => {
        const result = await boot("mode4.ssd", "Master");
        expect(result.state).toBe("prompt");
        expect(result.osMode).toBe(4);
        expect(result.screenText).toContain("HELLO BITMAP");
    });

    it("records the error a failed boot prints", async () => {
        const result = await boot("error.ssd");
        expect(result.state).toBe("prompt");
        expect(result.error).toBe("Bad command");
    });
});

describe("boot survey titles", () => {
    it("splits a title into words worth searching a screen for", () => {
        expect(titleWords("ThePhilosophersQuest v2")).toEqual(["philosophers", "quest"]);
        expect(titleWords("Repton 3 Game Disc")).toEqual(["repton"]);
    });

    it("names a disc from its mirror title, or failing that its file name", () => {
        expect(knownTitle({ title: "Exile", ref: "x.hfe" })).toBe("Exile");
        expect(knownTitle({ title: null, ref: "Cheats/CHT_Snapper.zip#Cheats/CHT_Snapper.ssd" })).toBe("Snapper");
        expect(knownTitle({ title: null, ref: "S/Solitaire-1492.ssd" })).toBe("Solitaire");
    });

    it("calls a catalogue title junk when it has no run of three letters", () => {
        expect(junkDfsTitle("")).toBe(true);
        expect(junkDfsTitle("\u0017\u0000\u0015")).toBe(true);
        expect(junkDfsTitle("023BA/1.0")).toBe(true);
        expect(junkDfsTitle("E L I T E")).toBe(true);
        expect(junkDfsTitle("REPTON3")).toBe(false);
    });
});

describe("boot survey machine claims", () => {
    const runs = (b, master) => ({ "B-DFS1.2": { state: b }, Master: { state: master } });
    const tankAttack = machineClaims("Fails on model B. Ok on Master.", "");

    it("agrees when the B fails and the Master boots as the note says", () => {
        expect(verdict(tankAttack, runs("prompt", "input"))).toBe("agree");
    });

    it("disagrees when the outcomes are the other way round", () => {
        expect(verdict(tankAttack, runs("input", "prompt"))).toBe("disagree");
    });

    it("can't settle a claim when both runs ended mostly in the MOS", () => {
        expect(verdict(tankAttack, runs("running-os", "running-os"))).toBe("unclear");
    });

    it("reads a Master requirement from a file name, and says nothing of the B", () => {
        const claims = machineClaims("", "Micropower/DoctorWhoAndTheMinesOfTerror-BPlusMaster.ssd");
        expect(claims).toEqual({ "B-DFS1.2": undefined, Master: true });
        expect(verdict(claims, runs("input", "disc-busy"))).toBe("disagree");
        expect(verdict(claims, runs("prompt", "running-ram"))).toBe("agree");
    });

    it("takes 'not Master compatible' as a claim the Master fails", () => {
        expect(machineClaims("Not Master compatible.", "").Master).toBe(false);
    });
});
