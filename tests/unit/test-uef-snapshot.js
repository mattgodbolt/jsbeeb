import { describe, it, expect } from "vitest";
import { isUefSnapshot, parseUefSnapshot } from "../../src/uef-snapshot.js";
import { RomBankBytes } from "../../src/6502.js";

const UefStateVersion = 15;

const ChunkId = {
    Cpu: 0x0460,
    RomRegs: 0x0461,
    MainRam: 0x0462,
    ShadowRam: 0x0463,
    PrivateRam: 0x0464,
    SwRam: 0x0466,
    Via: 0x0467,
    Video: 0x0468,
    EmuState: 0x046a,
    Sound: 0x046b,
    BeebEmId: 0x046c,
};

function chunk(id, data) {
    const bytes = new Uint8Array(6 + data.length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, id, true);
    view.setUint32(2, data.length, true);
    bytes.set(data, 6);
    return bytes;
}

function uefFile(chunks) {
    const header = new Uint8Array(12);
    new TextEncoder().encodeInto("UEF File!", header);
    header[10] = UefStateVersion;
    const file = new Uint8Array(12 + chunks.reduce((total, c) => total + c.length, 0));
    file.set(header);
    let pos = 12;
    for (const c of chunks) {
        file.set(c, pos);
        pos += c.length;
    }
    return file.buffer;
}

/**
 * A BeebEm UEF save state carrying the chunks the parser reads, each built from `opts` with
 * harmless defaults. `omit` lists chunk ids to leave out.
 */
function makeUefSnapshot(opts = {}) {
    const chunks = [];
    const add = (id, data) => {
        if (!opts.omit?.includes(id)) chunks.push(chunk(id, data));
    };

    const idBlock = new Uint8Array(16);
    new TextEncoder().encodeInto("BeebEm", idBlock);
    idBlock[14] = 5;
    idBlock[15] = 14;
    add(ChunkId.BeebEmId, idBlock);

    add(ChunkId.EmuState, [opts.machineType ?? 0, 0, 0]);

    const cpu = new Uint8Array(14);
    new DataView(cpu.buffer).setUint16(0, opts.pc ?? 0xd940, true);
    cpu.set([opts.a ?? 0x42, opts.x ?? 0x10, opts.y ?? 0x20, opts.s ?? 0xfd, opts.flags ?? 0x34], 2);
    cpu[12] = opts.nmi ?? 0;
    add(ChunkId.Cpu, cpu);

    add(ChunkId.RomRegs, [opts.fe30 ?? 0x0f, 0]);

    const mainRam = new Uint8Array(0x8000);
    if (opts.ramAddr !== undefined) mainRam[opts.ramAddr] = opts.ramByte;
    add(ChunkId.MainRam, mainRam);

    if (opts.shadowRam) add(ChunkId.ShadowRam, opts.shadowRam);
    if (opts.privateRam) add(ChunkId.PrivateRam, opts.privateRam);
    for (const { bank, fill } of opts.swRamBanks ?? []) {
        const bankData = new Uint8Array(1 + 16384).fill(fill);
        bankData[0] = bank;
        add(ChunkId.SwRam, bankData);
    }

    const via = opts.sysvia ?? {};
    const sysVia = new Uint8Array(22);
    const sysViaView = new DataView(sysVia.buffer);
    sysVia[1] = 0xff;
    sysVia[3] = 0xff;
    sysViaView.setUint16(7, via.t1c ?? 0x7fff, true);
    sysViaView.setUint16(9, via.t1l ?? 0xffff, true);
    sysViaView.setUint16(11, 0x7fff, true);
    sysViaView.setUint16(13, 0xffff, true);
    sysVia.set([via.acr ?? 0, 0, 0, 0x80, via.t1hit ?? 1, 1, opts.ic32 ?? 0], 15);
    add(ChunkId.Via, sysVia.subarray(0, opts.sysViaLength ?? sysVia.length));
    add(ChunkId.Via, [1, ...new Uint8Array(20)]);

    const video = new Uint8Array(35);
    video[18] = opts.ulaControl ?? 0x9c;
    if (opts.ulaPalette) video.set(opts.ulaPalette, 19);
    add(ChunkId.Video, video);

    const sound = opts.sound ?? {};
    const soundChunk = new Uint8Array(19);
    const soundView = new DataView(soundChunk.buffer);
    soundView.setUint16(0, sound.toneFreq0 ?? 0, true);
    soundView.setUint16(2, sound.toneFreq1 ?? 0, true);
    soundView.setUint16(4, sound.toneFreq2 ?? 0, true);
    soundChunk.set([sound.vol0 ?? 15, 15, 15, sound.noiseReg ?? 0, 15], 6);
    add(ChunkId.Sound, soundChunk);

    return uefFile(chunks);
}

function corrupt(offset, value) {
    const buffer = makeUefSnapshot();
    new Uint8Array(buffer)[offset] = value;
    return buffer;
}

describe("isUefSnapshot", () => {
    it("accepts a BeebEm UEF save state", () => {
        expect(isUefSnapshot(makeUefSnapshot())).toBe(true);
    });

    it.each([
        ["too small to hold a header", new ArrayBuffer(10)],
        ["the header is not 'UEF File!'", corrupt(0, 0x58)],
        ["the header's terminator is not zero", corrupt(9, 0xff)],
        ["the first chunk is not BeebEm's id", corrupt(12, 0x00)],
    ])("rejects a buffer when %s", (_, buffer) => {
        expect(isUefSnapshot(buffer)).toBe(false);
    });
});

const shadowRam = new Uint8Array(0x8000);
shadowRam[0x0000] = 0xff;
shadowRam[0x2fff] = 0xff;
shadowRam[0x3000] = 0xdd;
shadowRam[0x7fff] = 0xee;

const privateRam = new Uint8Array(0x3000);
privateRam[0x0000] = 0x11;
privateRam[0x0fff] = 0x22;
privateRam[0x1000] = 0x33;
privateRam[0x2fff] = 0x44;

const ulaPalette = new Uint8Array(16).fill(7);
ulaPalette[0] = 4;

describe("parseUefSnapshot", () => {
    it.each([
        [
            "identifies itself as an imported snapshot",
            {},
            (s) => [s.format, s.version, s.importedFrom],
            ["jsbeeb-snapshot", 3, "beebem-uef"],
        ],
        [
            "reads the CPU registers, with P's bits 4 and 5 always set",
            { a: 0x42, x: 0x10, y: 0x20, flags: 0xc5, s: 0xfd, pc: 0xd940 },
            ({ state }) => [state.a, state.x, state.y, state.p, state.s, state.pc],
            [0x42, 0x10, 0x20, 0xf5, 0xfd, 0xd940],
        ],
        ["reads the NMI level", { nmi: 1 }, (s) => s.state.nmiLevel, true],
        ["reads ROMSEL", { fe30: 0x05 }, (s) => s.state.romsel, 0x05],
        [
            "keeps only ROMSEL's bank bits (IntegraB sets MemSel above them)",
            { fe30: 0xf5 },
            (s) => s.state.romsel,
            0x05,
        ],
        ["reads main RAM", { ramAddr: 0x200, ramByte: 0xbb }, (s) => s.state.ram[0x200], 0xbb],
        [
            "puts main RAM at the bottom of a 64K array, leaving the rest clear",
            { ramAddr: 0x7fff, ramByte: 0xcc },
            ({ state }) => [
                state.ram.length,
                state.ram[0x7fff],
                state.ram[0x8000],
                state.ram[0x9000],
                state.ram[0xb000],
            ],
            [64 * 1024, 0xcc, 0, 0, 0],
        ],
        ["imports a B as a B", { machineType: 0 }, (s) => s.model, "B"],
        ["imports an IntegraB as a B", { machineType: 1 }, (s) => s.model, "B"],
        ["imports a B+ as a B", { machineType: 2 }, (s) => s.model, "B"],
        ["imports a Master as a Master", { machineType: 3 }, (s) => s.model, "Master"],
        ["imports a Master ET as a Master", { machineType: 4 }, (s) => s.model, "Master"],
        ["imports a machine that names no model as a B", { omit: [ChunkId.EmuState] }, (s) => s.model, "B"],
        [
            "gives every device a state",
            {},
            ({ state }) =>
                ["scheduler", "sysvia", "uservia", "video", "soundChip", "acia", "adc"].filter((k) => !state[k]),
            [],
        ],
        ["reads IC32 into the system VIA", { ic32: 0x3f }, (s) => s.state.sysvia.IC32, 0x3f],

        [
            "doubles the VIA timers, which BeebEm stores in 1MHz ticks",
            { sysvia: { t1c: 0x1234, t1l: 0x5678 } },
            ({ state }) => [state.sysvia.t1c, state.sysvia.t1l],
            [0x2468, 0xacf0],
        ],
        [
            "clears T1's hit flag in free-running mode",
            { sysvia: { acr: 0x40, t1hit: 1 } },
            (s) => s.state.sysvia.t1hit,
            false,
        ],
        [
            "keeps T1's hit flag in one-shot mode",
            { sysvia: { acr: 0x00, t1hit: 1 } },
            (s) => s.state.sysvia.t1hit,
            true,
        ],
        [
            "powers the VIAs on when the file has none",
            { omit: [ChunkId.Via] },
            ({ state }) => [state.sysvia.IC32, state.sysvia.ier, state.sysvia.t1hit, state.uservia.IC32],
            [0xff, 0x80, true, undefined],
        ],
        ["reads the video ULA's control register", { ulaControl: 0x4b }, (s) => s.state.video.ulactrl, 0x4b],
        [
            "reads the ULA palette as stored, without the hardware's XOR",
            { ulaPalette },
            (s) => s.state.video.actualPal[0],
            4,
        ],
        [
            "reads the tone periods",
            { sound: { toneFreq0: 0x03e8, toneFreq1: 0x01f4, toneFreq2: 0x00fa } },
            (s) => [...s.state.soundChip.registers.slice(0, 3)],
            [0x03e8, 0x01f4, 0x00fa],
        ],
        ["reads the noise register", { sound: { noiseReg: 0x07 } }, (s) => s.state.soundChip.registers[3], 0x07],
        [
            "silences a channel at attenuation 15",
            { sound: { vol0: 15 } },
            ({ state }) => [state.soundChip.volume[0], state.soundChip.outputBit[0]],
            [0, false],
        ],
        ["sounds a channel at attenuation 0", { sound: { vol0: 0 } }, (s) => s.state.soundChip.outputBit[0], true],
        [
            "loads no ROMs or sideways RAM when the file has none",
            {},
            ({ state }) => [state.roms, state.swram],
            [undefined, undefined],
        ],
        [
            "loads only the sideways RAM banks the file holds, never the ROM set",
            { swRamBanks: [{ bank: 4, fill: 0xaa }] },
            ({ state }) => [
                state.roms,
                state.swramBankMask,
                state.swram.length,
                state.swram[0],
                state.swram[RomBankBytes - 1],
            ],
            [undefined, 1 << 4, RomBankBytes, 0xaa, 0xaa],
        ],
        [
            "loads several sideways RAM banks",
            {
                swRamBanks: [
                    { bank: 4, fill: 0xaa },
                    { bank: 7, fill: 0xbb },
                ],
            },
            ({ state }) => [state.swramBankMask, state.swram[0], state.swram[RomBankBytes]],
            [(1 << 4) | (1 << 7), 0xaa, 0xbb],
        ],
        [
            "keeps only a sideways RAM bank number's low nibble",
            { swRamBanks: [{ bank: 0xf4, fill: 0xcc }] },
            (s) => [s.state.swramBankMask, s.state.swram[0]],
            [1 << 4, 0xcc],
        ],
        [
            "puts shadow RAM's top 20K in LYNNE and drops the rest",
            { shadowRam },
            ({ state }) => [state.ram[0x8000], state.ram[0xafff], state.ram[0xb000], state.ram[0xffff]],
            [0, 0, 0xdd, 0xee],
        ],
        [
            "puts private RAM in ANDY and HAZEL",
            { privateRam },
            ({ state }) => [state.ram[0x8000], state.ram[0x8fff], state.ram[0x9000], state.ram[0xafff]],
            [0x11, 0x22, 0x33, 0x44],
        ],
    ])("%s", (_, opts, pick, expected) => {
        expect(pick(parseUefSnapshot(makeUefSnapshot(opts)))).toEqual(expected);
    });

    it("ignores a final chunk that runs past the end of the file", () => {
        const buffer = makeUefSnapshot({ sound: { noiseReg: 0x07 } });
        const snap = parseUefSnapshot(buffer.slice(0, buffer.byteLength - 1));
        expect(snap.state.soundChip.registers[3]).toBe(0);
    });

    it.each([
        ["too small to hold a header", new ArrayBuffer(5), "File too small"],
        ["with no BeebEm id", new ArrayBuffer(100), "Not a BeebEm UEF save state"],
        ["with a short system VIA chunk", makeUefSnapshot({ sysViaLength: 10 }), "VIA chunk too short"],
        ["with no CPU chunk", makeUefSnapshot({ omit: [ChunkId.Cpu] }), "missing CPU chunk"],
        ["with no main RAM chunk", makeUefSnapshot({ omit: [ChunkId.MainRam] }), "missing main RAM chunk"],
    ])("rejects a file %s", (_, buffer, message) => {
        expect(() => parseUefSnapshot(buffer)).toThrow(message);
    });
});
