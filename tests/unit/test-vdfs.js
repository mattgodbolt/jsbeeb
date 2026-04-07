import { describe, it, expect } from "vitest";
import { parseInfFile, hostToBbcFilename, buildSsd, processHostFiles, discTitleFromFiles } from "../../src/vdfs.js";

// ── parseInfFile ────────────────────────────────────────────────────────────

describe("parseInfFile", () => {
    it("parses a typical .inf line with directory prefix", () => {
        const result = parseInfFile("$.ELITE FFFF1900 FFFF8023 00004000");
        expect(result).toEqual({ dir: "$", name: "ELITE", loadAddr: 0xffff1900, execAddr: 0xffff8023 });
    });

    it("parses a line with a non-default directory", () => {
        const result = parseInfFile("A.LOADER FF1900 FF8000");
        expect(result).toEqual({ dir: "A", name: "LOADER", loadAddr: 0xff1900, execAddr: 0xff8000 });
    });

    it("parses a line without a directory prefix", () => {
        const result = parseInfFile("HELLO 00000000 00000000");
        expect(result).toEqual({ dir: "$", name: "HELLO", loadAddr: 0, execAddr: 0 });
    });

    it("uppercases dir and name", () => {
        const result = parseInfFile("a.myfile 00001000 00001000");
        expect(result?.dir).toBe("A");
        expect(result?.name).toBe("MYFILE");
    });

    it("returns null for a line with too few parts", () => {
        expect(parseInfFile("TOOSHORT")).toBeNull();
    });

    it("handles Windows-style CRLF line endings", () => {
        const result = parseInfFile("$.FILE 00001000 00001000\r\n");
        expect(result).not.toBeNull();
        expect(result?.name).toBe("FILE");
    });

    it("ignores content after the third field", () => {
        const result = parseInfFile("$.FILE 00001000 00001000 0000800 L");
        expect(result).toEqual({ dir: "$", name: "FILE", loadAddr: 0x1000, execAddr: 0x1000 });
    });
});

// ── hostToBbcFilename ───────────────────────────────────────────────────────

describe("hostToBbcFilename", () => {
    it("strips a file extension", () => {
        expect(hostToBbcFilename("elite.bas")).toBe("ELITE");
    });

    it("truncates to 7 characters", () => {
        expect(hostToBbcFilename("verylongfilename.bas")).toBe("VERYLON");
    });

    it("uppercases the result", () => {
        expect(hostToBbcFilename("hello.bbc")).toBe("HELLO");
    });

    it("replaces invalid characters with underscore", () => {
        expect(hostToBbcFilename("my game.bas")).toBe("MY_GAME");
    });

    it("handles a name with no extension", () => {
        expect(hostToBbcFilename("MYFILE")).toBe("MYFILE");
    });

    it("handles a file name that is only an extension", () => {
        expect(hostToBbcFilename(".bas")).toBe("FILE");
    });

    it("keeps valid special characters", () => {
        expect(hostToBbcFilename("FILE-01.bas")).toBe("FILE-01");
    });
});

// ── buildSsd ────────────────────────────────────────────────────────────────

describe("buildSsd", () => {
    const SectorSize = 256;
    const TotalSectors = 800;

    it("produces a 204800-byte SSD image", () => {
        const ssd = buildSsd([]);
        expect(ssd.length).toBe(204800);
    });

    it("sets the disc title in sector 0 bytes 0–7", () => {
        const ssd = buildSsd([], "MYGAMES");
        const title = String.fromCharCode(...ssd.slice(0, 8)).trimEnd();
        expect(title).toBe("MYGAMES");
    });

    it("defaults to FILES as the disc title", () => {
        const ssd = buildSsd([]);
        const title = String.fromCharCode(...ssd.slice(0, 8)).trimEnd();
        expect(title).toBe("FILES");
    });

    it("stores the file count in sector 1 byte 6", () => {
        const files = [
            { name: "ONE", data: new Uint8Array(100) },
            { name: "TWO", data: new Uint8Array(200) },
        ];
        const ssd = buildSsd(files);
        expect(ssd[SectorSize + 6]).toBe(files.length * 8); // 2 * 8 = 16
    });

    it("sets total sectors correctly in sector 1 bytes 5 and 7", () => {
        const ssd = buildSsd([]);
        // 800 = 0x320; high bits (bits 9–8) = 3; low byte = 0x20 = 32
        expect(ssd[SectorSize + 5]).toBe((TotalSectors >> 8) & 0x03);
        expect(ssd[SectorSize + 7]).toBe(TotalSectors & 0xff);
    });

    it("writes the filename into sector 0 for each file", () => {
        const files = [{ name: "ELITE", data: new Uint8Array(10) }];
        const ssd = buildSsd(files);
        const fname = String.fromCharCode(...ssd.slice(8, 15)).trimEnd();
        expect(fname).toBe("ELITE");
    });

    it("stores the directory char at sector 0 byte 7 of each entry", () => {
        const files = [{ name: "FILE", dir: "A", data: new Uint8Array(10) }];
        const ssd = buildSsd(files);
        expect(ssd[15]).toBe("A".charCodeAt(0)); // sector 0 offset 8+7=15
    });

    it("defaults to $ directory when none specified", () => {
        const files = [{ name: "FILE", data: new Uint8Array(10) }];
        const ssd = buildSsd(files);
        expect(ssd[15]).toBe("$".charCodeAt(0));
    });

    it("writes load and exec addresses in little-endian to sector 1", () => {
        const files = [{ name: "FILE", loadAddr: 0x1234, execAddr: 0x5678, data: new Uint8Array(1) }];
        const ssd = buildSsd(files);
        const s1Entry = SectorSize + 8; // sector 1, file 0 entry
        expect(ssd[s1Entry + 0]).toBe(0x34); // loadAddr low byte
        expect(ssd[s1Entry + 1]).toBe(0x12); // loadAddr high byte
        expect(ssd[s1Entry + 2]).toBe(0x78); // execAddr low byte
        expect(ssd[s1Entry + 3]).toBe(0x56); // execAddr high byte
    });

    it("writes the file length in sector 1", () => {
        const data = new Uint8Array(512);
        const files = [{ name: "FILE", data }];
        const ssd = buildSsd(files);
        const s1Entry = SectorSize + 8;
        const len = ssd[s1Entry + 4] | (ssd[s1Entry + 5] << 8);
        expect(len).toBe(512);
    });

    it("stores the start sector for the first file at sector 2", () => {
        const files = [{ name: "FIRST", data: new Uint8Array(256) }];
        const ssd = buildSsd(files);
        const s1Entry = SectorSize + 8;
        const startSectorLow = ssd[s1Entry + 7];
        const startSectorHigh = (ssd[s1Entry + 6] >> 6) & 0x03;
        const startSector = (startSectorHigh << 8) | startSectorLow;
        expect(startSector).toBe(2); // sectors 0 and 1 are the catalogue
    });

    it("places consecutive files at non-overlapping sectors", () => {
        const files = [
            { name: "FIRST", data: new Uint8Array(512) }, // 2 sectors
            { name: "SECOND", data: new Uint8Array(256) }, // 1 sector
        ];
        const ssd = buildSsd(files);

        function getStartSector(index) {
            const off = SectorSize + 8 + index * 8;
            return ((ssd[off + 6] >> 6) & 0x03) * 256 + ssd[off + 7];
        }
        expect(getStartSector(0)).toBe(2);
        expect(getStartSector(1)).toBe(4); // 2 + ceil(512/256) = 4
    });

    it("places file data at the correct byte offset in the image", () => {
        const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const ssd = buildSsd([{ name: "TEST", data }]);
        // First file starts at sector 2 = byte offset 512
        expect(ssd[512]).toBe(0xde);
        expect(ssd[513]).toBe(0xad);
        expect(ssd[514]).toBe(0xbe);
        expect(ssd[515]).toBe(0xef);
    });

    it("limits to MaxFiles (31) entries", () => {
        const files = Array.from({ length: 40 }, (_, i) => ({
            name: `F${String(i).padStart(2, "0")}`,
            data: new Uint8Array(1),
        }));
        const ssd = buildSsd(files);
        expect(ssd[SectorSize + 6]).toBe(31 * 8);
    });

    it("handles an empty file correctly", () => {
        const ssd = buildSsd([{ name: "EMPTY", data: new Uint8Array(0) }]);
        const s1Entry = SectorSize + 8;
        const len = ssd[s1Entry + 4] | (ssd[s1Entry + 5] << 8);
        expect(len).toBe(0);
    });
});

// ── processHostFiles ─────────────────────────────────────────────────────────

describe("processHostFiles", () => {
    function makeFile(name, content) {
        // Create a minimal File-like object compatible with processHostFiles
        const textEncoder = new TextEncoder();
        const bytes = typeof content === "string" ? textEncoder.encode(content) : content;
        return new File([bytes], name);
    }

    it("converts a plain file to BBC metadata", async () => {
        const files = [makeFile("hello.bas", "10 PRINT")];
        const result = await processHostFiles(files);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("HELLO");
        expect(result[0].dir).toBe("$");
    });

    it("uses .inf sidecar metadata when present", async () => {
        const files = [makeFile("hello.bas", "10 PRINT"), makeFile("hello.bas.inf", "$.HELLO FFFF1900 FFFF8023")];
        const result = await processHostFiles(files);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("HELLO");
        expect(result[0].loadAddr).toBe(0xffff1900);
        expect(result[0].execAddr).toBe(0xffff8023);
    });

    it("skips .inf files from the output list", async () => {
        const files = [makeFile("prog.bas", "10 REM"), makeFile("prog.bas.inf", "$.PROG 00000000 00000000")];
        const result = await processHostFiles(files);
        expect(result).toHaveLength(1);
    });

    it("skips hidden files (starting with .)", async () => {
        const files = [makeFile(".DS_Store", "data")];
        const result = await processHostFiles(files);
        expect(result).toHaveLength(0);
    });

    it("disambiguates duplicate BBC names by appending a suffix", async () => {
        const files = [makeFile("hello.bas", "10 REM"), makeFile("hello.txt", "world")];
        const result = await processHostFiles(files);
        expect(result).toHaveLength(2);
        const names = result.map((f) => f.name);
        expect(new Set(names).size).toBe(2); // both names are unique
        expect(names[0]).toBe("HELLO");
        expect(names[1]).toBe("HELLO1");
    });

    it("preserves file data", async () => {
        const data = new Uint8Array([1, 2, 3, 4]);
        const files = [new File([data], "test.dat")];
        const result = await processHostFiles(files);
        expect(result[0].data).toEqual(data);
    });
});

// ── discTitleFromFiles ───────────────────────────────────────────────────────

describe("discTitleFromFiles", () => {
    it("returns empty string for an empty file list", () => {
        expect(discTitleFromFiles([])).toBe("");
    });

    it("extracts the folder name from webkitRelativePath", () => {
        const file = new File(["data"], "ELITE");
        Object.defineProperty(file, "webkitRelativePath", { value: "MyGames/ELITE" });
        expect(discTitleFromFiles([file])).toBe("MYGAMES");
    });

    it("returns empty string when webkitRelativePath is absent", () => {
        const file = new File(["data"], "ELITE");
        expect(discTitleFromFiles([file])).toBe("");
    });

    it("truncates to 8 characters", () => {
        const file = new File(["data"], "x");
        Object.defineProperty(file, "webkitRelativePath", { value: "VeryLongFolderName/x" });
        expect(discTitleFromFiles([file])).toHaveLength(8);
    });
});
