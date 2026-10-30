import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { isBemSnapshot, parseBemSnapshot } from "../../src/bem-snapshot.js";

const BemSnapshotSize = 327885;
const BemModelB = 3;

function makeMinimalBemSnapshot(overrides = {}) {
    const buffer = new ArrayBuffer(BemSnapshotSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    bytes.set(new TextEncoder().encode("BEMSNAP1"), 0);
    view.setUint8(8, overrides.model ?? BemModelB);
    view.setUint8(9, overrides.a ?? 0x42);
    view.setUint8(10, overrides.x ?? 0x10);
    view.setUint8(11, overrides.y ?? 0x20);
    view.setUint8(12, overrides.flags ?? 0x30);
    view.setUint8(13, overrides.s ?? 0xfd);
    view.setUint16(14, overrides.pc ?? 0xd940, true);
    view.setUint8(16, overrides.nmi ?? 0);
    view.setUint8(17, overrides.interrupt ?? 0);
    view.setUint32(18, overrides.cycles ?? 12345, true);
    view.setUint8(22, overrides.fe30 ?? 0x0f);
    if (overrides.ramByte !== undefined) {
        bytes[24 + (overrides.ramAddr ?? 0)] = overrides.ramByte;
    }

    return buffer;
}

function withSignature(signature) {
    const buffer = new ArrayBuffer(BemSnapshotSize);
    new Uint8Array(buffer).set(new TextEncoder().encode(signature));
    return buffer;
}

describe("isBemSnapshot", () => {
    it("accepts a BEMSNAP1", () => {
        expect(isBemSnapshot(makeMinimalBemSnapshot())).toBe(true);
    });

    it.each([
        ["the wrong size", new ArrayBuffer(100)],
        ["the wrong signature", withSignature("NOTASNAP")],
    ])("rejects a buffer of %s", (_, buffer) => {
        expect(isBemSnapshot(buffer)).toBe(false);
    });
});

describe("parseBemSnapshot", () => {
    it.each([
        [
            "reads the CPU registers, with P's bits 4 and 5 always set",
            { a: 0x42, x: 0x10, y: 0x20, flags: 0xc5, s: 0xfd, pc: 0xd940 },
            (s) => [s.format, s.version, s.state.a, s.state.x, s.state.y, s.state.p, s.state.s, s.state.pc],
            ["jsbeeb-snapshot", 3, 0x42, 0x10, 0x20, 0xf5, 0xfd, 0xd940],
        ],
        ["reads the NMI level", { nmi: 1 }, (s) => s.state.nmiLevel, true],
        ["reads ROMSEL", { fe30: 0x05 }, (s) => s.state.romsel, 0x05],
        ["reads RAM", { ramAddr: 0x100, ramByte: 0xaa }, (s) => s.state.ram[0x100], 0xaa],
        ["builds a 64K RAM array", {}, (s) => s.state.ram.length, 64 * 1024],
        ["imports a B as a B", { model: 3 }, (s) => s.model, "B"],
        ["imports a B with sideways RAM as a B", { model: 4 }, (s) => s.model, "B"],
        ["imports an A with OS 0.1 as a B with MOS 0.10", { model: 0 }, (s) => s.model, "B-MOS0.10"],
        ["imports a B with OS 0.1 as a B with MOS 0.10", { model: 1 }, (s) => s.model, "B-MOS0.10"],
    ])("%s", async (_, overrides, pick, expected) => {
        expect(pick(await parseBemSnapshot(makeMinimalBemSnapshot(overrides)))).toEqual(expected);
    });

    it("gives every device a state", async () => {
        const { state } = await parseBemSnapshot(makeMinimalBemSnapshot());
        const present = expect.anything();
        expect(state).toMatchObject({
            scheduler: present,
            sysvia: { ora: present, IC32: present },
            uservia: { ora: present },
            video: { ula: present, crtc: present, teletext: present },
            soundChip: present,
            acia: present,
            adc: present,
        });
    });

    it.each([
        ["a model other than a B", makeMinimalBemSnapshot({ model: 5 })],
        ["the wrong size", new ArrayBuffer(100)],
        ["the wrong signature", withSignature("NOTSNAP!")],
    ])("rejects a file of %s as unsupported", async (_, buffer) => {
        await expect(parseBemSnapshot(buffer)).rejects.toThrow(/Unsupported/);
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
    // Compressed sections flag the key and carry a 4-byte length rather than 2.
    const lengthBytes = compressed ? 4 : 2;
    const header = [key.charCodeAt(0) | (compressed ? 0x80 : 0)];
    for (let i = 0; i < lengthBytes; i++) header.push((data.length >>> (i * 8)) & 0xff);
    return [...header, ...data];
}

/**
 * Build a BEMSNAP3 carrying only the model and tube sections, which is all the tube import
 * needs. `ula` and `parasite` are sparse overrides applied to otherwise-zeroed state.
 */
async function makeBemV3WithTube({
    modelName = "BBC B",
    tubeName = "6502 External",
    tubeState = true,
    ula = {},
    parasite = {},
    ramSize = 65536,
    romSize = 2048,
    ulaBytes = 51,
} = {}) {
    const model = [
        ...encodeVar(3),
        ...[modelName, "os12", "", "std", "none"].flatMap(encodeString),
        ...new Array(6).fill(0), // model flag bytes
        ...(tubeName ? [1, ...encodeString(tubeName)] : [0]),
    ];

    const ulaSection = new Uint8Array(ulaBytes);
    ulaSection[0] = 2; // struct version
    ulaSection[1] = ula.romPaged ?? 1;
    for (const [offset, value] of Object.entries(ula.fields ?? {})) ulaSection[2 + Number(offset)] = value;

    const { a = 0, x = 0, y = 0, s = 0, pc = 0, flags = 0, oldnmi = 0 } = parasite;
    const parasiteBytes = new Uint8Array(9 + ramSize + romSize);
    parasiteBytes.set([0, oldnmi, a, x, y, flags, s, pc & 0xff, pc >> 8]);
    for (const [addr, value] of Object.entries(parasite.memory ?? {})) parasiteBytes[9 + Number(addr)] = value;

    return new Uint8Array([
        ...new TextEncoder().encode("BEMSNAP3"),
        ...section("m", model),
        ...(tubeState ? section("T", ulaSection) : []),
        ...(tubeState ? section("P", await deflate(parasiteBytes), true) : []),
    ]).buffer;
}

describe("b-em v3 model import", () => {
    it.each([
        ["BBC B w/8271 FDC", "B"],
        ["BBC B w/1770 FDC", "B1770"],
        ["Master 128", "Master"],
        ["BBC A w/OS 0.1", "B-MOS0.10"],
        ["BBC B w/OS 0.1", "B-MOS0.10"],
    ])("imports a %s as %s", async (modelName, expected) => {
        const buffer = await makeBemV3WithTube({ modelName, tubeName: null, tubeState: false });

        expect((await parseBemSnapshot(buffer)).model).toBe(expected);
    });

    it("reads a real b-em v3 file", async () => {
        const file = readFileSync(new URL("../frogman.snp", import.meta.url));
        const { model, state } = await parseBemSnapshot(
            file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
        );

        expect(model).toBe("Master");
        expect(state.roms.length).toBe(256 * 1024);
        expect(state.video.regs[0]).toBe(127);
        expect(state.video.ulactrl).not.toBe(0);
    });
});

describe("b-em tube import", () => {
    it("imports the parasite processor state", async () => {
        const buffer = await makeBemV3WithTube({
            parasite: { a: 0x11, x: 0x22, y: 0x33, s: 0x44, pc: 0xf800, oldnmi: 1, memory: { 0x1234: 0x99 } },
        });

        const snapshot = await parseBemSnapshot(buffer);

        expect(snapshot.coProcessor).toBe(true);
        expect(snapshot.state.tube).toMatchObject({
            a: 0x11,
            x: 0x22,
            y: 0x33,
            s: 0x44,
            pc: 0xf800,
            nmiLevel: true,
            romPaged: true,
        });
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
        const snapshot = await parseBemSnapshot(await makeBemV3WithTube({ tubeName: null, tubeState: false }));

        expect(snapshot.coProcessor).toBe(false);
        expect(snapshot.state.tube).toBeUndefined();
    });

    it.each([
        [
            "a co-processor that is a different CPU entirely",
            { tubeName: "Z80 ROM 1.21" },
            /only emulates the 64K 65C02/,
        ],
        [
            "the 6502 Turbo, whose 16MB of RAM jsbeeb cannot hold",
            { tubeName: "6502 Turbo", ramSize: 0x1000000 },
            /only emulates the 64K 65C02/,
        ],
        ["a parasite with less than 64K of RAM", { ramSize: 16384 }, /parasite RAM/],
        [
            "a renamed Turbo, which gets past the name check on its RAM size alone",
            { ramSize: 0x1000000 },
            /parasite RAM/,
        ],
        ["a truncated ULA section", { ulaBytes: 20 }, /Truncated b-em tube ULA/],
        ["more bytes queued in R1 than its FIFO holds", { ula: { fields: { 46: 30 } } }, /FIFO counts out of range/],
        ["R1's head past the end of its FIFO", { ula: { fields: { 45: 24 } } }, /FIFO counts out of range/],
        ["an overfull R3", { ula: { fields: { 48: 3 } } }, /FIFO counts out of range/],
        ["co-processor state that names no co-processor", { tubeName: null }, /names no co-processor/],
    ])("rejects %s", async (_, options, message) => {
        await expect(parseBemSnapshot(await makeBemV3WithTube(options))).rejects.toThrow(message);
    });

    it("accepts a parasite whose ROM size b-em's config left unset", async () => {
        const snapshot = await parseBemSnapshot(await makeBemV3WithTube({ romSize: 0 }));

        expect(snapshot.coProcessor).toBe(true);
    });
});
