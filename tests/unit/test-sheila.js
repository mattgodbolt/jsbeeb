import { describe, expect, it } from "vitest";

import { sheilaAddress, sheilaBlocks, sheilaName, sheilaRegister } from "../../src/sheila.js";
import { allModels, findModel } from "../../src/models.js";

const NoFittings = { hasTube: false, hasEconet: false, hasVideoNula: false };
const blocksOf = (name, fittings = {}) => sheilaBlocks({ model: findModel(name), ...NoFittings, ...fittings });
const named = (blocks, address, access) => {
    const found = sheilaRegister(blocks, address, access);
    return found && `${found.block.device}.${found.name}`;
};

describe("SHEILA register names", () => {
    it("names the VIAs on every BBC, by direction, through their mirrors", () => {
        for (const name of ["B-DFS1.2", "B1770", "Master"]) {
            const blocks = blocksOf(name);
            expect(named(blocks, 0xfe40, "write")).toBe("SysVIA.ORB");
            expect(named(blocks, 0xfe40, "read")).toBe("SysVIA.IRB");
            expect(named(blocks, 0xfe5d, "read")).toBe("SysVIA.IFR");
            expect(named(blocks, 0xfe64, "write")).toBe("UserVIA.T1LL");
            expect(named(blocks, 0xfe64, "read")).toBe("UserVIA.T1CL");
        }
    });

    it("finds a B's 8271 at &FE80, with its own read and write registers", () => {
        const blocks = blocksOf("B-DFS1.2");
        const status = sheilaRegister(blocks, 0xfe80, "read");
        expect(status.block.title).toBe("8271 disc controller");
        expect(status.name).toBe("STATUS");
        expect(named(blocks, 0xfe80, "write")).toBe("FDC.COMMAND");
        expect(named(blocks, 0xfe82, "write")).toBe("FDC.RESET");
        expect(named(blocks, 0xfe82, "read")).toBe("FDC.COUNT_HI");
        expect(named(blocks, 0xfe9c, "read")).toBe("FDC.DATA");
    });

    it("finds a B's 1770 at &FE84 behind its drive control latch", () => {
        const blocks = blocksOf("B1770");
        expect(sheilaRegister(blocks, 0xfe84, "read").block.title).toBe("1770 disc controller");
        expect(named(blocks, 0xfe80, "write")).toBe("FDC.CONTROL");
        expect(named(blocks, 0xfe80, "read")).toBeUndefined();
        expect(named(blocks, 0xfe84, "read")).toBe("FDC.STATUS");
        expect(named(blocks, 0xfe84, "write")).toBe("FDC.COMMAND");
        expect(named(blocks, 0xfe85, "write")).toBe("FDC.TRACK");
    });

    it("finds the Master's 1770, ADC and paging registers where the B has others or none", () => {
        const blocks = blocksOf("Master");
        expect(named(blocks, 0xfe24, "write")).toBe("FDC.CONTROL");
        expect(named(blocks, 0xfe28, "read")).toBe("FDC.STATUS");
        expect(named(blocks, 0xfe2b, "write")).toBe("FDC.DATA");
        expect(named(blocks, 0xfe18, "read")).toBe("ADC.STATUS");
        expect(named(blocks, 0xfe30, "read")).toBe("Paging.ROMSEL");
        expect(named(blocks, 0xfe34, "write")).toBe("Paging.ACCCON");
        expect(named(blocks, 0xfe80, "read")).toBeUndefined();
        expect(named(blocks, 0xfec0, "read")).toBeUndefined();

        const b = blocksOf("B-DFS1.2");
        expect(named(b, 0xfe34, "write")).toBe("Paging.ROMSEL");
        expect(named(b, 0xfe34, "read")).toBeUndefined();
        expect(named(b, 0xfe28, "write")).toBe("VideoULA.CONTROL");
        expect(named(b, 0xfec1, "read")).toBe("ADC.HIGH");
    });

    it("names Econet's registers only with Econet fitted, where reads and writes of &FE20 part on a B", () => {
        expect(named(blocksOf("B-DFS1.2"), 0xfe18, "read")).toBeUndefined();
        expect(named(blocksOf("B-DFS1.2"), 0xfea0, "read")).toBeUndefined();
        const b = blocksOf("B-DFS1.2", { hasEconet: true });
        expect(named(b, 0xfe18, "read")).toBe("Econet.INTOFF");
        expect(named(b, 0xfe20, "read")).toBe("Econet.INTON");
        expect(named(b, 0xfe2c, "read")).toBe("Econet.INTON");
        expect(named(b, 0xfe20, "write")).toBe("VideoULA.CONTROL");
        expect(named(b, 0xfea0, "read")).toBe("ADLC.SR1");
        const master = blocksOf("Master", { hasEconet: true });
        expect(named(master, 0xfe38, "read")).toBe("Econet.INTOFF");
        expect(named(master, 0xfe3c, "read")).toBe("Econet.INTON");
    });

    it("names VideoNuLA's registers only with it fitted, the ULA's mirrors standing in otherwise", () => {
        expect(named(blocksOf("B-DFS1.2"), 0xfe22, "write")).toBe("VideoULA.CONTROL");
        expect(named(blocksOf("B-DFS1.2", { hasVideoNula: true }), 0xfe22, "write")).toBe("VideoULA.NULA_CONTROL");
        expect(named(blocksOf("Master", { hasVideoNula: true }), 0xfe23, "write")).toBe("VideoULA.NULA_PALETTE");
    });

    it("names the Tube's registers only with a second processor fitted", () => {
        expect(named(blocksOf("Master"), 0xfee5, "read")).toBeUndefined();
        expect(named(blocksOf("Master", { hasTube: true }), 0xfee5, "read")).toBe("Tube.R3");
        expect(named(blocksOf("B-DFS1.2", { hasTube: true }), 0xfee0, "write")).toBe("Tube.CONTROL");
    });

    it("names a read-modify-write's chip once, or each chip where reads and writes part", () => {
        const b = blocksOf("B-DFS1.2", { hasEconet: true });
        expect(sheilaName(b, 0xfe80, ["read", "write"])).toEqual({
            name: "FDC.STATUS/COMMAND",
            title: "8271 disc controller STATUS/COMMAND: $fe80",
        });
        expect(sheilaName(b, 0xfe4d, ["read", "write"]).name).toBe("SysVIA.IFR");
        expect(sheilaName(b, 0xfe20, ["read", "write"]).name).toBe("Econet.INTON/VideoULA.CONTROL");
        expect(sheilaName(b, 0xfe30, ["read", "write"]).name).toBe("Paging.ROMSEL");
        expect(sheilaName(b, 0xfe30, ["read"])).toBeUndefined();
    });

    it.each([
        ["SysVIA.ORB", 0xfe40],
        ["sysvia.irb", 0xfe40],
        ["UserVIA.IFR", 0xfe6d],
        ["FDC.DATA", 0xfe84],
        ["Paging.ROMSEL", 0xfe30],
        ["SysVIA", undefined],
        ["Tube", undefined],
        ["SysVIA.ORB.junk", undefined],
        ["SysVIA.NOPE", undefined],
    ])("finds the address %s names", (text, address) => {
        expect(sheilaAddress(blocksOf("B-DFS1.2"), text)).toBe(address);
    });

    it("has nothing for an Atom", () => {
        expect(blocksOf("Atom")).toEqual([]);
    });

    it.each(allModels.filter((model) => model.name.startsWith("BBC")).map((model) => [model.name, model]))(
        "answers each address and direction from at most one block of SHEILA on %s",
        (_, model) => {
            const blocks = sheilaBlocks({ model, hasTube: true, hasEconet: true, hasVideoNula: true });
            for (const block of blocks) {
                expect(block.start).toBeGreaterThanOrEqual(0xfe00);
                expect(block.end).toBeLessThanOrEqual(0xff00);
            }
            for (let address = 0xfe00; address < 0xff00; address++) {
                for (const access of ["read", "write"]) {
                    const answering = blocks.filter((block) => sheilaRegister([block], address, access));
                    expect(answering.length, `$${address.toString(16)} ${access}`).toBeLessThanOrEqual(1);
                }
            }
        },
    );
});
