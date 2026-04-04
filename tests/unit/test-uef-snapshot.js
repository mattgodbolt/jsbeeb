import { describe, it, expect } from "vitest";
import { isUefSnapshot, parseUefSnapshot } from "../../src/uef-snapshot.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Build a minimal but structurally valid BeebEm UEF save state buffer.
 * Only the chunks needed for the tested fields are written; all others are omitted.
 */
function makeUefSnapshot(opts = {}) {
    const chunks = [];

    // Helper: append a chunk with the given id and data bytes
    function addChunk(id, data) {
        const idBytes = new Uint8Array(2);
        new DataView(idBytes.buffer).setUint16(0, id, true);
        const lenBytes = new Uint8Array(4);
        new DataView(lenBytes.buffer).setUint32(0, data.length, true);
        chunks.push(idBytes, lenBytes, data instanceof Uint8Array ? data : new Uint8Array(data));
    }

    // 0x046C – BeebEm ID (required for detection)
    const idBlock = new Uint8Array(16);
    new TextEncoder().encodeInto("BeebEm", idBlock);
    idBlock[14] = 5; // VERSION_MAJOR
    idBlock[15] = 14; // VERSION_MINOR
    addChunk(0x046c, idBlock);

    // 0x046A – Emulator state (model + FDC + tube)
    const machineType = opts.machineType ?? 0; // 0 = BBC B
    addChunk(0x046a, new Uint8Array([machineType, 0, 0]));

    // 0x0460 – 6502 CPU
    const cpuChunk = new Uint8Array(14);
    const cpuView = new DataView(cpuChunk.buffer);
    cpuView.setUint16(0, opts.pc ?? 0xd940, true);
    cpuChunk[2] = opts.a ?? 0x42;
    cpuChunk[3] = opts.x ?? 0x10;
    cpuChunk[4] = opts.y ?? 0x20;
    cpuChunk[5] = opts.s ?? 0xfd;
    cpuChunk[6] = opts.flags ?? 0x34;
    cpuView.setUint32(7, 0, true); // TotalCycles (ignored)
    cpuChunk[11] = opts.interrupt ?? 0; // intStatus
    cpuChunk[12] = opts.nmi ?? 0; // NMIStatus
    cpuChunk[13] = 0; // NMILock
    addChunk(0x0460, cpuChunk);

    // 0x0461 – ROM registers
    addChunk(0x0461, new Uint8Array([opts.fe30 ?? 0x0f, opts.fe34 ?? 0x00]));

    // 0x0462 – Main RAM (32 KB)
    const mainRam = new Uint8Array(32768);
    if (opts.ramAddr !== undefined && opts.ramByte !== undefined) {
        mainRam[opts.ramAddr] = opts.ramByte;
    }
    addChunk(0x0462, mainRam);

    // 0x0463 – Shadow RAM (optional, 32 KB)
    if (opts.shadowRam) {
        addChunk(0x0463, opts.shadowRam);
    }

    // 0x0464 – Private RAM (optional, up to 12 KB)
    if (opts.privateRam) {
        addChunk(0x0464, opts.privateRam);
    }

    // 0x0466 – Sideways RAM banks (optional, one chunk per bank)
    if (opts.swRamBanks) {
        for (const { bank, fill } of opts.swRamBanks) {
            const bankData = new Uint8Array(1 + 16384);
            bankData[0] = bank;
            bankData.fill(fill, 1);
            addChunk(0x0466, bankData);
        }
    }

    // 0x0467 – System VIA
    const sysVia = new Uint8Array(22);
    sysVia[0] = 0; // VIAType = sys
    sysVia[1] = opts.sysvia?.orb ?? 0xff;
    sysVia[3] = opts.sysvia?.ora ?? 0xff;
    const svView = new DataView(sysVia.buffer);
    svView.setUint16(7, opts.sysvia?.t1c ?? 0x7fff, true);
    svView.setUint16(9, opts.sysvia?.t1l ?? 0xffff, true);
    svView.setUint16(11, opts.sysvia?.t2c ?? 0x7fff, true);
    svView.setUint16(13, opts.sysvia?.t2l ?? 0xffff, true);
    sysVia[15] = opts.sysvia?.acr ?? 0x00;
    sysVia[16] = opts.sysvia?.pcr ?? 0x00;
    sysVia[17] = opts.sysvia?.ifr ?? 0x00;
    sysVia[18] = opts.sysvia?.ier ?? 0x80;
    sysVia[19] = opts.sysvia?.t1hit ?? 1;
    sysVia[20] = opts.sysvia?.t2hit ?? 1;
    sysVia[21] = opts.ic32 ?? 0x00; // IC32
    addChunk(0x0467, sysVia);

    // 0x0467 – User VIA
    const userVia = new Uint8Array(21);
    userVia[0] = 1; // VIAType = user
    addChunk(0x0467, userVia);

    // 0x0468 – Video
    const videoChunk = new Uint8Array(35);
    // CRTC regs 0-17 (leave as zero / harmless defaults)
    videoChunk[18] = opts.ulaControl ?? 0x9c; // VideoULA_ControlReg
    // Palette: stored as actual ^ 7; leave as zero (decoded = 0 ^ 7 = 7 for each)
    if (opts.ulaPalette) {
        for (let i = 0; i < 16; i++) videoChunk[19 + i] = opts.ulaPalette[i] ^ 7;
    }
    addChunk(0x0468, videoChunk);

    // 0x046B – Sound
    const soundChunk = new Uint8Array(19);
    const sv = new DataView(soundChunk.buffer);
    sv.setUint16(0, opts.sound?.toneFreq0 ?? 0, true); // ToneFreq[2] → ch 0
    sv.setUint16(2, opts.sound?.toneFreq1 ?? 0, true); // ToneFreq[1] → ch 1
    sv.setUint16(4, opts.sound?.toneFreq2 ?? 0, true); // ToneFreq[0] → ch 2
    soundChunk[6] = opts.sound?.vol0 ?? 15; // ch 0 vol (15 = silent)
    soundChunk[7] = opts.sound?.vol1 ?? 15;
    soundChunk[8] = opts.sound?.vol2 ?? 15;
    soundChunk[9] = opts.sound?.noiseReg ?? 0x00;
    soundChunk[10] = opts.sound?.volNoise ?? 15;
    addChunk(0x046b, soundChunk);

    // Assemble: UEF header (10 bytes) + version (2 bytes) + all chunks
    const header = new Uint8Array(12);
    new TextEncoder().encodeInto("UEF File!", header);
    header[9] = 0; // null terminator
    header[10] = 15; // minor version (UEFSTATE_VERSION)
    header[11] = 0; // major version

    const totalLen = 12 + chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(totalLen);
    result.set(header, 0);
    let pos = 12;
    for (const c of chunks) {
        result.set(c, pos);
        pos += c.length;
    }
    return result.buffer;
}

// ── isUefSnapshot ─────────────────────────────────────────────────────────────

describe("isUefSnapshot", () => {
    it("returns true for a valid BeebEm UEF save state", () => {
        const buffer = makeUefSnapshot();
        expect(isUefSnapshot(buffer)).toBe(true);
    });

    it("returns false for a buffer that is too small", () => {
        expect(isUefSnapshot(new ArrayBuffer(10))).toBe(false);
    });

    it("returns false when the header is not 'UEF File!'", () => {
        const buffer = makeUefSnapshot();
        new Uint8Array(buffer)[0] = 0x58; // corrupt first byte
        expect(isUefSnapshot(buffer)).toBe(false);
    });

    it("returns false when the null terminator after the header is wrong", () => {
        const buffer = makeUefSnapshot();
        new Uint8Array(buffer)[9] = 0xff; // corrupt null byte
        expect(isUefSnapshot(buffer)).toBe(false);
    });

    it("returns false when the first chunk ID is not 0x046C", () => {
        const buffer = makeUefSnapshot();
        // Bytes 12-13 are the first chunk ID; change it to 0x0100 (tape data chunk)
        new DataView(buffer).setUint16(12, 0x0100, true);
        expect(isUefSnapshot(buffer)).toBe(false);
    });
});

// ── parseUefSnapshot ──────────────────────────────────────────────────────────

describe("parseUefSnapshot", () => {
    it("produces a jsbeeb-snapshot with the correct format and version", () => {
        const buffer = makeUefSnapshot();
        const snap = parseUefSnapshot(buffer);
        expect(snap.format).toBe("jsbeeb-snapshot");
        expect(snap.version).toBe(2);
        expect(snap.importedFrom).toBe("beebem-uef");
    });

    it("parses CPU registers correctly", () => {
        const buffer = makeUefSnapshot({ a: 0x42, x: 0x10, y: 0x20, flags: 0xe5, s: 0xfd, pc: 0xd940 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.a).toBe(0x42);
        expect(snap.state.x).toBe(0x10);
        expect(snap.state.y).toBe(0x20);
        expect(snap.state.p).toBe(0xe5 | 0x30); // bits 4+5 always set
        expect(snap.state.s).toBe(0xfd);
        expect(snap.state.pc).toBe(0xd940);
    });

    it("parses NMI state", () => {
        const buffer = makeUefSnapshot({ nmi: 1 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.nmiLevel).toBe(true);
    });

    it("parses ROM select register (FE30)", () => {
        const buffer = makeUefSnapshot({ fe30: 0x05 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.romsel).toBe(0x05);
    });

    it("masks the ROM bank to the low nibble of PagedRomReg", () => {
        // BeebEm sometimes sets upper bits (e.g. IntegraB MemSel bit)
        const buffer = makeUefSnapshot({ fe30: 0xf5 }); // 0xf5 & 0x0f = 5
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.romsel).toBe(0x05);
    });

    it("parses main RAM contents", () => {
        const buffer = makeUefSnapshot({ ramAddr: 0x200, ramByte: 0xbb });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.ram[0x200]).toBe(0xbb);
    });

    it("populates 128 KB ram array with main RAM in first 32 KB", () => {
        const buffer = makeUefSnapshot({ ramAddr: 0x7fff, ramByte: 0xcc });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.ram.length).toBe(128 * 1024);
        expect(snap.state.ram[0x7fff]).toBe(0xcc);
        // Bytes above 32 KB should be zero (no shadow RAM supplied)
        expect(snap.state.ram[0x8000]).toBe(0);
    });

    it("defaults to BBC B model", () => {
        const buffer = makeUefSnapshot({ machineType: 0 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.model).toBe("B");
    });

    it("maps machineType 3 to Master model", () => {
        const buffer = makeUefSnapshot({ machineType: 3 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.model).toBe("Master");
    });

    it("maps machineType 4 (MasterET) to Master model", () => {
        const buffer = makeUefSnapshot({ machineType: 4 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.model).toBe("Master");
    });

    it("maps machineType 2 (B+) to B model (no B+ in jsbeeb)", () => {
        const buffer = makeUefSnapshot({ machineType: 2 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.model).toBe("B");
    });

    it("maps machineType 1 (IntegraB) to B model", () => {
        const buffer = makeUefSnapshot({ machineType: 1 });
        const snap = parseUefSnapshot(buffer);
        expect(snap.model).toBe("B");
    });

    it("includes required sub-component state structures", () => {
        const buffer = makeUefSnapshot();
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.scheduler).toBeDefined();
        expect(snap.state.sysvia).toBeDefined();
        expect(snap.state.uservia).toBeDefined();
        expect(snap.state.video).toBeDefined();
        expect(snap.state.soundChip).toBeDefined();
        expect(snap.state.acia).toBeDefined();
        expect(snap.state.adc).toBeDefined();
    });

    it("includes IC32 in the sys VIA state", () => {
        const buffer = makeUefSnapshot({ ic32: 0x3f });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.sysvia.IC32).toBe(0x3f);
    });

    it("sets capsLockLight based on IC32", () => {
        // bit 6 of IC32 = caps lock (0 = light on)
        const buffer = makeUefSnapshot({ ic32: 0xbf }); // bit 6 clear → caps on
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.sysvia.capsLockLight).toBe(true);

        const buffer2 = makeUefSnapshot({ ic32: 0xff }); // bit 6 set → caps off
        const snap2 = parseUefSnapshot(buffer2);
        expect(snap2.state.sysvia.capsLockLight).toBe(false);
    });

    it("converts VIA timer values to 2x peripheral-cycle units", () => {
        // BeebEm saves counter / 2; file value * 2 = jsbeeb value
        const buffer = makeUefSnapshot({ sysvia: { t1c: 0x1234, t1l: 0x5678 } });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.sysvia.t1c).toBe(0x1234 * 2);
        expect(snap.state.sysvia.t1l).toBe(0x5678 * 2);
    });

    it("parses video ULA control register", () => {
        const buffer = makeUefSnapshot({ ulaControl: 0x9c });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.video.ulactrl).toBe(0x9c);
    });

    it("decodes ULA palette (stored XOR'd with 7 in UEF)", () => {
        // Set palette entry 0 to physical colour 3 (stored as 3^7 = 4 in file)
        const ulaPalette = new Uint8Array(16).fill(7); // all entries = physical 7 (white)
        ulaPalette[0] = 3; // entry 0 → physical 3 (yellow)
        const buffer = makeUefSnapshot({ ulaPalette });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.video.actualPal[0]).toBe(3);
    });

    it("parses sound tone frequencies", () => {
        const buffer = makeUefSnapshot({
            sound: { toneFreq0: 0x03e8, toneFreq1: 0x01f4, toneFreq2: 0x00fa },
        });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.soundChip.registers[0]).toBe(0x03e8);
        expect(snap.state.soundChip.registers[1]).toBe(0x01f4);
        expect(snap.state.soundChip.registers[2]).toBe(0x00fa);
    });

    it("parses sound noise register", () => {
        // noise register bits 0-2 only
        const buffer = makeUefSnapshot({ sound: { noiseReg: 0x07 } });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.soundChip.registers[3]).toBe(0x07);
    });

    it("converts sound volumes using the volume table (15 = silent)", () => {
        const buffer = makeUefSnapshot({ sound: { vol0: 15 } });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.soundChip.volume[0]).toBe(0);
        expect(snap.state.soundChip.outputBit[0]).toBe(false);
    });

    it("sets outputBit to true for non-silent channels", () => {
        const buffer = makeUefSnapshot({ sound: { vol0: 0 } }); // 0 = maximum volume
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.soundChip.outputBit[0]).toBe(true);
    });

    it("throws for a non-UEF-snapshot buffer", () => {
        expect(() => parseUefSnapshot(new ArrayBuffer(100))).toThrow();
    });

    it("throws for a buffer that is too small", () => {
        expect(() => parseUefSnapshot(new ArrayBuffer(5))).toThrow();
    });

    it("includes null roms when no sideways RAM chunks are present", () => {
        const buffer = makeUefSnapshot();
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.roms).toBeUndefined();
    });

    // ── Sideways RAM tests ──────────────────────────────────────────────

    it("parses a single sideways RAM bank", () => {
        const buffer = makeUefSnapshot({ swRamBanks: [{ bank: 4, fill: 0xaa }] });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.roms).not.toBeNull();
        expect(snap.state.roms.length).toBe(16 * 16384);
        expect(snap.state.roms[4 * 16384]).toBe(0xaa);
        expect(snap.state.roms[4 * 16384 + 16383]).toBe(0xaa);
        // Other banks should be zero
        expect(snap.state.roms[0]).toBe(0);
        expect(snap.state.roms[5 * 16384]).toBe(0);
    });

    it("parses multiple sideways RAM banks", () => {
        const buffer = makeUefSnapshot({
            swRamBanks: [
                { bank: 4, fill: 0xaa },
                { bank: 7, fill: 0xbb },
            ],
        });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.roms[4 * 16384]).toBe(0xaa);
        expect(snap.state.roms[7 * 16384]).toBe(0xbb);
    });

    it("masks sideways RAM bank number to low nibble", () => {
        const buffer = makeUefSnapshot({ swRamBanks: [{ bank: 0xf4, fill: 0xcc }] });
        const snap = parseUefSnapshot(buffer);
        // 0xF4 & 0x0F = 4
        expect(snap.state.roms[4 * 16384]).toBe(0xcc);
    });

    // ── Shadow RAM tests ────────────────────────────────────────────────

    it("parses 32 KB shadow RAM into LYNNE region", () => {
        const shadowRam = new Uint8Array(0x8000);
        shadowRam[0x3000] = 0xdd; // first byte of LYNNE region
        shadowRam[0x7fff] = 0xee; // last byte of LYNNE region
        const buffer = makeUefSnapshot({ shadowRam });
        const snap = parseUefSnapshot(buffer);
        // LYNNE lives at ram[0xB000-0xFFFF]
        expect(snap.state.ram[0xb000]).toBe(0xdd);
        expect(snap.state.ram[0xffff]).toBe(0xee);
        // Bytes before LYNNE should be unaffected (main RAM region)
        expect(snap.state.ram[0xafff]).toBe(0);
    });

    it("ignores shadow RAM bytes outside the LYNNE region", () => {
        const shadowRam = new Uint8Array(0x8000);
        shadowRam[0x0000] = 0xff; // below LYNNE - should be ignored
        shadowRam[0x2fff] = 0xff; // just below LYNNE - should be ignored
        const buffer = makeUefSnapshot({ shadowRam });
        const snap = parseUefSnapshot(buffer);
        // These addresses in the ram array should not be affected
        expect(snap.state.ram[0x8000]).toBe(0); // ANDY region, not shadow
    });

    // ── Private RAM tests ───────────────────────────────────────────────

    it("parses private RAM into ANDY and HAZEL regions", () => {
        const privateRam = new Uint8Array(0x3000); // 12 KB
        privateRam[0x0000] = 0x11; // ANDY start
        privateRam[0x0fff] = 0x22; // ANDY end
        privateRam[0x1000] = 0x33; // HAZEL start
        privateRam[0x2fff] = 0x44; // HAZEL end
        const buffer = makeUefSnapshot({ privateRam });
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.ram[0x8000]).toBe(0x11); // ANDY
        expect(snap.state.ram[0x8fff]).toBe(0x22);
        expect(snap.state.ram[0x9000]).toBe(0x33); // HAZEL
        expect(snap.state.ram[0xafff]).toBe(0x44);
    });

    it("leaves ANDY/HAZEL/LYNNE as zero when no shadow/private chunks present", () => {
        const buffer = makeUefSnapshot();
        const snap = parseUefSnapshot(buffer);
        expect(snap.state.ram[0x8000]).toBe(0); // ANDY
        expect(snap.state.ram[0x9000]).toBe(0); // HAZEL
        expect(snap.state.ram[0xb000]).toBe(0); // LYNNE
    });
});
