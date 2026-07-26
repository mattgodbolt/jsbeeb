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
    it("should parse CPU registers correctly", async () => {
        const buffer = makeMinimalBemSnapshot({
            a: 0x42,
            x: 0x10,
            y: 0x20,
            flags: 0xe5,
            s: 0xfd,
            pc: 0xd940,
        });

        const snapshot = await parseBemSnapshot(buffer);

        expect(snapshot.format).toBe("jsbeeb-snapshot");
        expect(snapshot.version).toBe(3);
        expect(snapshot.model).toBe("B");
        expect(snapshot.state.a).toBe(0x42);
        expect(snapshot.state.x).toBe(0x10);
        expect(snapshot.state.y).toBe(0x20);
        expect(snapshot.state.p).toBe(0xe5 | 0x30);
        expect(snapshot.state.s).toBe(0xfd);
        expect(snapshot.state.pc).toBe(0xd940);
    });

    it("should parse NMI state", async () => {
        const buffer = makeMinimalBemSnapshot({ nmi: 1 });
        const snapshot = await parseBemSnapshot(buffer);
        expect(snapshot.state.nmiLevel).toBe(true);
    });

    it("should parse ROM select register", async () => {
        const buffer = makeMinimalBemSnapshot({ fe30: 0x05 });
        const snapshot = await parseBemSnapshot(buffer);
        expect(snapshot.state.romsel).toBe(0x05);
    });

    it("should parse RAM contents", async () => {
        const buffer = makeMinimalBemSnapshot({ ramAddr: 0x100, ramByte: 0xaa });
        const snapshot = await parseBemSnapshot(buffer);
        expect(snapshot.state.ram[0x100]).toBe(0xaa);
    });

    it("should reject non-Model B snapshots", async () => {
        const buffer = makeMinimalBemSnapshot({ model: 5 });
        await expect(parseBemSnapshot(buffer)).rejects.toThrow(/Unsupported/);
    });

    it("should reject wrong size", async () => {
        const buffer = new ArrayBuffer(100);
        await expect(parseBemSnapshot(buffer)).rejects.toThrow(/Unsupported/);
    });

    it("should reject wrong signature", async () => {
        const buffer = new ArrayBuffer(BemSnapshotSize);
        new Uint8Array(buffer).set(new TextEncoder().encode("NOTSNAP!"), 0);
        await expect(parseBemSnapshot(buffer)).rejects.toThrow(/Unsupported/);
    });

    it("should include sub-component state structures", async () => {
        const buffer = makeMinimalBemSnapshot();
        const snapshot = await parseBemSnapshot(buffer);

        expect(snapshot.state.scheduler).toBeDefined();
        expect(snapshot.state.sysvia).toBeDefined();
        expect(snapshot.state.uservia).toBeDefined();
        expect(snapshot.state.video).toBeDefined();
        expect(snapshot.state.soundChip).toBeDefined();
        expect(snapshot.state.acia).toBeDefined();
        expect(snapshot.state.adc).toBeDefined();

        expect(snapshot.state.sysvia.ora).toBeDefined();
        expect(snapshot.state.sysvia.IC32).toBeDefined();
        expect(snapshot.state.uservia.ora).toBeDefined();

        expect(snapshot.state.video.ula).toBeDefined();
        expect(snapshot.state.video.crtc).toBeDefined();
        expect(snapshot.state.video.teletext).toBeDefined();
    });

    it("should accept model 4 (BBC B with sideways RAM)", async () => {
        const buffer = makeMinimalBemSnapshot({ model: 4 });
        const snapshot = await parseBemSnapshot(buffer);
        expect(snapshot.model).toBe("B");
    });
});

async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function encodeVar(value) {
    // b-em's variable-length integer: 7 bits per byte, top bit marks the last one.
    const out = [];
    while (value >= 0x80) {
        out.push(value & 0x7f);
        value >>= 7;
    }
    out.push(value | 0x80);
    return out;
}

function encodeString(str) {
    return [...encodeVar(str.length), ...new TextEncoder().encode(str)];
}

function section(key, data, compressed = false) {
    const code = key.charCodeAt(0);
    if (compressed) {
        return [
            code | 0x80,
            data.length & 0xff,
            (data.length >> 8) & 0xff,
            (data.length >> 16) & 0xff,
            data.length >>> 24,
            ...data,
        ];
    }
    return [code, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

/**
 * Build a BEMSNAP3 carrying only the model and tube sections, which is all the tube import
 * needs. `ula` and `parasite` are sparse overrides applied to otherwise-zeroed state.
 */
async function makeBemV3WithTube({ tubeName = "6502 External", ula = {}, parasite = {}, ramSize = 65536 } = {}) {
    const model = [
        ...encodeVar(3),
        ...encodeString("BBC B"),
        ...encodeString("os12"),
        ...encodeString(""),
        ...encodeString("std"),
        ...encodeString("none"),
        0,
        0,
        0,
        0,
        0,
        0,
        ...(tubeName ? [1, ...encodeString(tubeName)] : [0]),
    ];

    const ulaBytes = new Uint8Array(51);
    ulaBytes[0] = 2; // struct version
    ulaBytes[1] = ula.romPaged ?? 1;
    for (const [offset, value] of Object.entries(ula.fields ?? {})) ulaBytes[2 + Number(offset)] = value;

    const parasiteBytes = new Uint8Array(9 + ramSize + 2048);
    parasiteBytes[1] = parasite.oldnmi ?? 0;
    parasiteBytes[2] = parasite.a ?? 0;
    parasiteBytes[3] = parasite.x ?? 0;
    parasiteBytes[4] = parasite.y ?? 0;
    parasiteBytes[5] = parasite.flags ?? 0;
    parasiteBytes[6] = parasite.s ?? 0;
    parasiteBytes[7] = (parasite.pc ?? 0) & 0xff;
    parasiteBytes[8] = (parasite.pc ?? 0) >> 8;
    for (const [addr, value] of Object.entries(parasite.memory ?? {})) parasiteBytes[9 + Number(addr)] = value;

    return new Uint8Array([
        ...new TextEncoder().encode("BEMSNAP3"),
        ...section("m", model),
        ...section("T", ulaBytes),
        ...section("P", await deflate(parasiteBytes), true),
    ]).buffer;
}

describe("b-em tube import", () => {
    it("imports the parasite processor state", async () => {
        const buffer = await makeBemV3WithTube({
            parasite: { a: 0x11, x: 0x22, y: 0x33, s: 0x44, pc: 0xf800, oldnmi: 1, memory: { 0x1234: 0x99 } },
        });

        const snapshot = await parseBemSnapshot(buffer);

        expect(snapshot.coProcessor).toBe(true);
        expect(snapshot.state.tube.a).toBe(0x11);
        expect(snapshot.state.tube.x).toBe(0x22);
        expect(snapshot.state.tube.y).toBe(0x33);
        expect(snapshot.state.tube.s).toBe(0x44);
        expect(snapshot.state.tube.pc).toBe(0xf800);
        expect(snapshot.state.tube.nmiLevel).toBe(true);
        expect(snapshot.state.tube.romPaged).toBe(true);
        expect(snapshot.state.tube.memory[0x1234]).toBe(0x99);
    });

    it("linearises the circular R1 FIFO into the order jsbeeb reads it", async () => {
        // Three bytes sitting at the end of the 24-byte ring, wrapping to the start.
        const fields = { 22: 0xaa, 23: 0xbb, 0: 0xcc, 45: 22, 46: 3 }; // ph1[22], ph1[23], ph1[0], head, count
        const buffer = await makeBemV3WithTube({ ula: { fields } });

        const snapshot = await parseBemSnapshot(buffer);

        expect([...snapshot.state.tube.ula.parasiteToHostData[0].slice(0, 3)]).toEqual([0xaa, 0xbb, 0xcc]);
        expect(snapshot.state.tube.ula.parasiteToHostFifoByteCount1).toBe(3);
    });

    it("reports no co-processor when none was fitted", async () => {
        const buffer = new Uint8Array([
            ...new TextEncoder().encode("BEMSNAP3"),
            ...section("m", [
                ...encodeVar(3),
                ...encodeString("BBC B"),
                ...encodeString("os12"),
                ...encodeString(""),
                ...encodeString("std"),
                ...encodeString("none"),
                0,
                0,
                0,
                0,
                0,
                0,
                0,
            ]),
        ]).buffer;

        const snapshot = await parseBemSnapshot(buffer);

        expect(snapshot.coProcessor).toBe(false);
        expect(snapshot.state.tube).toBeUndefined();
    });

    it("rejects co-processors that are a different CPU entirely", async () => {
        const buffer = await makeBemV3WithTube({ tubeName: "Z80 ROM 1.21" });

        await expect(parseBemSnapshot(buffer)).rejects.toThrow(/only emulates the 64K 65C02/);
    });

    it("rejects the 6502 Turbo, whose 16MB of RAM jsbeeb cannot hold", async () => {
        const buffer = await makeBemV3WithTube({ tubeName: "6502 Turbo", ramSize: 0x1000000 });

        await expect(parseBemSnapshot(buffer)).rejects.toThrow(/only emulates the 64K 65C02/);
    });

    it("rejects a parasite whose RAM is not the 64K jsbeeb emulates", async () => {
        await expect(parseBemSnapshot(await makeBemV3WithTube({ ramSize: 16384 }))).rejects.toThrow(/parasite state/);
        // A renamed Turbo in b-em's config would get past the name check on size alone.
        await expect(parseBemSnapshot(await makeBemV3WithTube({ ramSize: 0x1000000 }))).rejects.toThrow(
            /parasite state/,
        );
    });
});
