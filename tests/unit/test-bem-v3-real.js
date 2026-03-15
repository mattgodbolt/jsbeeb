import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseBemSnapshot, isBemSnapshot } from "../../src/bem-snapshot.js";

const snpPath = resolve(dirname(fileURLToPath(import.meta.url)), "../frogman.snp");
// Node's Buffer can share an ArrayBuffer with a non-zero byteOffset,
// so slice to get a correctly-aligned copy.
const nodeBuffer = readFileSync(snpPath);
const buffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength);

describe("BEMv3 real snapshot (frogman.snp)", () => {
    it("should detect as BEM snapshot", () => {
        expect(isBemSnapshot(buffer)).toBe(true);
    });

    it("should parse CPU state correctly", async () => {
        const snapshot = await parseBemSnapshot(buffer);

        expect(snapshot.model).toBe("Master");
        expect(snapshot.state.a).toBeLessThanOrEqual(0xff);
        expect(snapshot.state.pc).toBeGreaterThan(0);
        expect(snapshot.state.pc).toBeLessThanOrEqual(0xffff);
    });

    it("should decompress memory and extract latches", async () => {
        const snapshot = await parseBemSnapshot(buffer);

        // fe30/fe34 should come from the memory section header, not be zero
        expect(snapshot.state.romsel).toBeDefined();
        expect(snapshot.state.acccon).toBeDefined();

        // RAM should have non-zero content
        const nonZero = snapshot.state.ram.some((b) => b !== 0);
        expect(nonZero).toBe(true);

        // ROMs should be present (256KB)
        expect(snapshot.state.roms).toBeDefined();
        expect(snapshot.state.roms.length).toBe(262144);
    });

    it("should have valid VIA state", async () => {
        const snapshot = await parseBemSnapshot(buffer);

        expect(snapshot.state.sysvia.IC32).toBeDefined();
        expect(snapshot.state.sysvia.ora).toBeLessThanOrEqual(0xff);
        expect(snapshot.state.uservia.ora).toBeLessThanOrEqual(0xff);
    });

    it("should have valid video state", async () => {
        const snapshot = await parseBemSnapshot(buffer);

        // CRTC R0 should be 127 for standard modes
        expect(snapshot.state.video.regs[0]).toBe(127);
        // ULA control should be non-zero
        expect(snapshot.state.video.ulactrl).toBeGreaterThan(0);
    });
});
