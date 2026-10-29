import { describe, expect, it } from "vitest";

import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import { bankOffset, fitRomHeader } from "./helpers.js";
import {
    AndyView,
    describeBank,
    MainView,
    PagedView,
    parseViewedAddress,
    peekViewed,
    requireBank,
    ShadowView,
    viewDiffers,
    viewsFor,
} from "../../src/paging.js";

const Master = findModel("Master");
const ModelB = findModel("B-DFS1.2");
const FourSocketB = findModel("B-stock");
const Atom = findModel("Atom");
const AccconX = 0x04;
const RomselAndy = 0x80;

async function machine(model) {
    const cpu = fake6502(model);
    await cpu.initialise();
    return cpu;
}

describe("paging views", () => {
    it.each([
        [Master, "8000", { address: "8000", view: undefined }],
        [Master, "8000`4", { address: "8000", view: "4" }],
        [Master, "4:8000", { address: "8000", view: "4" }],
        [Master, "&8000`F", { address: "&8000", view: "f" }],
        [Master, "OSWRCH`a", { address: "OSWRCH", view: "a" }],
        [Master, "a:OSWRCH", { address: "OSWRCH", view: "a" }],
        [Master, "3000`s", { address: "3000", view: ShadowView }],
        [Master, "m:3000", { address: "3000", view: MainView }],
        [Master, "N:8000", { address: "8000", view: AndyView }],
        [ModelB, "8000`0", { address: "8000", view: "0" }],
        [ModelB, "3000`s", undefined],
        [ModelB, "n:8000", undefined],
        [FourSocketB, "8000`4", undefined],
        [FourSocketB, "c:8000", { address: "8000", view: "c" }],
        [Atom, "8000`4", undefined],
        [Atom, "a000", { address: "a000", view: undefined }],
    ])("reads a Go to on %s: %s", (model, text, parsed) => {
        expect(parseViewedAddress(text, model)).toEqual(parsed);
    });

    it("offers each model the views it has", () => {
        expect(viewsFor(Atom)).toEqual([PagedView]);
        expect(viewsFor(FourSocketB)).toEqual([PagedView, "c", "d", "e", "f"]);
        expect(viewsFor(ModelB)).toHaveLength(17);
        expect(viewsFor(Master).slice(-3)).toEqual([AndyView, MainView, ShadowView]);
    });

    it("checks a bank is one the model's sockets reach", () => {
        expect(() => requireBank(12, FourSocketB)).not.toThrow();
        expect(() => requireBank(undefined, FourSocketB)).not.toThrow();
        expect(() => requireBank(4, FourSocketB)).toThrow("Bank 4 is not 12 to 15");
        expect(() => requireBank(1.5, ModelB)).toThrow("Bank 1.5 is not 0 to 15");
    });

    it("reads each view where it applies and as paged elsewhere, leaving the paging alone", async () => {
        const cpu = await machine(Master);
        cpu.romSelect(15);
        cpu.writeAcccon(0);
        cpu.ramRomOs[bankOffset(cpu, 4, 0x8123)] = 0x44;
        cpu.ramRomOs[0x8123] = 0xa4;
        cpu.ramRomOs[0x3456] = 0x11;
        cpu.ramRomOs[0x8000 + 0x3456] = 0x55;
        cpu.ramRomOs[0x1234] = 0x12;
        const paged = cpu.peekmem(0x8123);

        expect(peekViewed(cpu, "4", 0x8123)).toBe(0x44);
        expect(peekViewed(cpu, AndyView, 0x8123)).toBe(0xa4);
        expect(peekViewed(cpu, ShadowView, 0x3456)).toBe(0x55);
        expect(peekViewed(cpu, MainView, 0x3456)).toBe(0x11);
        expect(peekViewed(cpu, PagedView, 0x8123)).toBe(paged);
        expect(peekViewed(cpu, "4", 0x1234)).toBe(0x12);
        expect(peekViewed(cpu, ShadowView, 0x8123)).toBe(paged);
        expect([cpu.romsel, cpu.acccon]).toEqual([15, 0]);
    });

    it("says where a view shows other than what the CPU reads now", async () => {
        const cpu = await machine(Master);
        cpu.romSelect(4);
        cpu.writeAcccon(0);
        expect(viewDiffers(cpu, "4", 0x8000)).toBe(false);
        expect(viewDiffers(cpu, "5", 0x8000)).toBe(true);
        expect(viewDiffers(cpu, "5", 0x2000)).toBe(false);
        expect(viewDiffers(cpu, MainView, 0x3000)).toBe(false);
        expect(viewDiffers(cpu, ShadowView, 0x3000)).toBe(true);
        cpu.writeAcccon(AccconX);
        expect(viewDiffers(cpu, ShadowView, 0x3000)).toBe(false);
        cpu.romSelect(4 | RomselAndy);
        expect(viewDiffers(cpu, "4", 0x8000)).toBe(true);
        expect(viewDiffers(cpu, "4", 0x9000)).toBe(false);
        expect(viewDiffers(cpu, AndyView, 0x8000)).toBe(false);
    });

    it("describes a bank by its ROM's title and version, or by what it is with no ROM", async () => {
        const cpu = await machine(ModelB);
        fitRomHeader(cpu, 3, "BASIC");
        fitRomHeader(cpu, 5, "DFS", "2.26");
        cpu.ramRomOs.fill(0xff, bankOffset(cpu, 6, 0x8000), bankOffset(cpu, 7, 0x8000));
        expect(describeBank(cpu, 3)).toBe("BASIC");
        expect(describeBank(cpu, 5)).toBe("DFS 2.26");
        expect(describeBank(cpu, 6)).toBe("sideways RAM");
        expect(describeBank(cpu, 15)).toMatch(/^BASIC/);
        expect(describeBank(await machine(Master), 0)).toBe("empty");
    });
});
