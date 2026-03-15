import { describe, it, expect } from "vitest";
import { isBemSnapshot, parseBemSnapshot } from "../../src/bem-snapshot.js";

const BemSnapshotSize = 327885;

function makeMinimalBemSnapshot(overrides = {}) {
    const buffer = new ArrayBuffer(BemSnapshotSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Signature
    const sig = new TextEncoder().encode("BEMSNAP1");
    bytes.set(sig, 0);

    // Model (3 = BBC Model B)
    view.setUint8(8, overrides.model ?? 3);

    // CPU registers
    view.setUint8(9, overrides.a ?? 0x42);
    view.setUint8(10, overrides.x ?? 0x10);
    view.setUint8(11, overrides.y ?? 0x20);
    view.setUint8(12, overrides.flags ?? 0x30);
    view.setUint8(13, overrides.s ?? 0xfd);
    view.setUint16(14, overrides.pc ?? 0xd940, true);
    view.setUint8(16, overrides.nmi ?? 0);
    view.setUint8(17, overrides.interrupt ?? 0);
    view.setUint32(18, overrides.cycles ?? 12345, true);

    // fe30 (ROM select)
    view.setUint8(22, overrides.fe30 ?? 0x0f);

    // RAM: write a marker byte
    if (overrides.ramByte !== undefined) {
        bytes[24 + (overrides.ramAddr ?? 0)] = overrides.ramByte;
    }

    return buffer;
}

describe("isBemSnapshot", () => {
    it("should return true for a valid BEM snapshot", () => {
        const buffer = makeMinimalBemSnapshot();
        expect(isBemSnapshot(buffer)).toBe(true);
    });

    it("should return false for wrong size", () => {
        const buffer = new ArrayBuffer(100);
        expect(isBemSnapshot(buffer)).toBe(false);
    });

    it("should return false for wrong signature", () => {
        const buffer = new ArrayBuffer(BemSnapshotSize);
        new Uint8Array(buffer).set(new TextEncoder().encode("NOTASNAP"), 0);
        expect(isBemSnapshot(buffer)).toBe(false);
    });
});

describe("parseBemSnapshot", () => {
    it("should parse CPU registers correctly", () => {
        const buffer = makeMinimalBemSnapshot({
            a: 0x42,
            x: 0x10,
            y: 0x20,
            flags: 0xe5,
            s: 0xfd,
            pc: 0xd940,
        });

        const snapshot = parseBemSnapshot(buffer);

        expect(snapshot.format).toBe("jsbeeb-snapshot");
        expect(snapshot.version).toBe(1);
        expect(snapshot.model).toBe("B");
        expect(snapshot.state.a).toBe(0x42);
        expect(snapshot.state.x).toBe(0x10);
        expect(snapshot.state.y).toBe(0x20);
        expect(snapshot.state.p).toBe(0xe5 | 0x30);
        expect(snapshot.state.s).toBe(0xfd);
        expect(snapshot.state.pc).toBe(0xd940);
    });

    it("should parse NMI state", () => {
        const buffer = makeMinimalBemSnapshot({ nmi: 1 });
        const snapshot = parseBemSnapshot(buffer);
        expect(snapshot.state.nmiLevel).toBe(true);
    });

    it("should parse ROM select register", () => {
        const buffer = makeMinimalBemSnapshot({ fe30: 0x05 });
        const snapshot = parseBemSnapshot(buffer);
        expect(snapshot.state.romsel).toBe(0x05);
    });

    it("should parse RAM contents", () => {
        const buffer = makeMinimalBemSnapshot({ ramAddr: 0x100, ramByte: 0xaa });
        const snapshot = parseBemSnapshot(buffer);
        expect(snapshot.state.ram[0x100]).toBe(0xaa);
    });

    it("should reject non-Model B snapshots", () => {
        const buffer = makeMinimalBemSnapshot({ model: 5 });
        expect(() => parseBemSnapshot(buffer)).toThrow(/Unsupported BEM model/);
    });

    it("should reject wrong size", () => {
        const buffer = new ArrayBuffer(100);
        expect(() => parseBemSnapshot(buffer)).toThrow(/Invalid BEM snapshot size/);
    });

    it("should reject wrong signature", () => {
        const buffer = new ArrayBuffer(BemSnapshotSize);
        new Uint8Array(buffer).set(new TextEncoder().encode("NOTSNAP!"), 0);
        expect(() => parseBemSnapshot(buffer)).toThrow(/Invalid BEM snapshot signature/);
    });

    it("should include sub-component state structures", () => {
        const buffer = makeMinimalBemSnapshot();
        const snapshot = parseBemSnapshot(buffer);

        // Verify all expected sub-components exist
        expect(snapshot.state.scheduler).toBeDefined();
        expect(snapshot.state.sysvia).toBeDefined();
        expect(snapshot.state.uservia).toBeDefined();
        expect(snapshot.state.video).toBeDefined();
        expect(snapshot.state.soundChip).toBeDefined();
        expect(snapshot.state.acia).toBeDefined();
        expect(snapshot.state.adc).toBeDefined();

        // VIA should have expected fields
        expect(snapshot.state.sysvia.ora).toBeDefined();
        expect(snapshot.state.sysvia.IC32).toBeDefined();
        expect(snapshot.state.uservia.ora).toBeDefined();

        // Video should have nested state
        expect(snapshot.state.video.ula).toBeDefined();
        expect(snapshot.state.video.crtc).toBeDefined();
        expect(snapshot.state.video.teletext).toBeDefined();
    });

    it("should accept model 4 (BBC B with sideways RAM)", () => {
        const buffer = makeMinimalBemSnapshot({ model: 4 });
        const snapshot = parseBemSnapshot(buffer);
        expect(snapshot.model).toBe("B");
    });
});
