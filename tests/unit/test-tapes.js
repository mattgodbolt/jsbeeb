import { describe, it, expect } from "vitest";
import { loadTapeFromData } from "../../src/tapes.js";

// Build a minimal UEF file: "UEF File!\0" + version (minor, major) + chunks.
// UefTape constructor reads the first chunk, so at least one must be present.
function makeUef(chunks) {
    const header = [
        // "UEF File!\0"
        0x55, 0x45, 0x46, 0x20, 0x46, 0x69, 0x6c, 0x65, 0x21, 0x00,
        // Version: minor=6, major=0
        0x06, 0x00,
    ];
    const parts = [new Uint8Array(header)];
    for (const chunk of chunks) {
        // chunk id (16-bit LE) + length (32-bit LE) + data
        const chunkHeader = new Uint8Array(6);
        chunkHeader[0] = chunk.id & 0xff;
        chunkHeader[1] = (chunk.id >> 8) & 0xff;
        const len = chunk.data ? chunk.data.length : 0;
        chunkHeader[2] = len & 0xff;
        chunkHeader[3] = (len >> 8) & 0xff;
        chunkHeader[4] = (len >> 16) & 0xff;
        chunkHeader[5] = (len >> 24) & 0xff;
        parts.push(chunkHeader);
        if (chunk.data) parts.push(new Uint8Array(chunk.data));
    }
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

// Build a minimal tapefile: 0xFF 0x04 header + padding to 10 bytes + data.
// The tapefile format starts with carrier (0xFF 0x04), then data follows at offset 10.
function makeTapefile(data = []) {
    const buf = new Uint8Array(10 + data.length);
    buf[0] = 0xff;
    buf[1] = 0x04;
    for (let i = 0; i < data.length; i++) {
        buf[10 + i] = data[i];
    }
    return buf;
}

function mockAcia() {
    return {
        setTapeCarrier: () => {},
        tone: () => {},
        receive: () => {},
        cr: 0x00,
    };
}

describe("tapes", () => {
    describe("loadTapeFromData", () => {
        it("should detect UEF format", async () => {
            const uef = makeUef([{ id: 0x0100, data: [0x41] }]);
            const tape = await loadTapeFromData("test.uef", uef);
            expect(tape).not.toBeNull();
            expect(tape.constructor.name).toBe("UefTape");
        });

        it("should detect tapefile format", async () => {
            const tapefile = makeTapefile();
            const tape = await loadTapeFromData("test.tape", tapefile);
            expect(tape).not.toBeNull();
            expect(tape.constructor.name).toBe("TapefileTape");
        });

        it("should return null for unknown format", async () => {
            const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
            const tape = await loadTapeFromData("test.bin", unknown);
            expect(tape).toBeNull();
        });

        it("should reject UEF with unsupported major version", async () => {
            const uef = makeUef([{ id: 0x0100, data: [0x41] }]);
            uef[11] = 0x01; // major version 1
            await expect(loadTapeFromData("test.uef", uef)).rejects.toThrow(/Unsupported UEF version/);
        });
    });

    describe("UefTape", () => {
        it("should parse data chunks (0x0100)", async () => {
            const uef = makeUef([{ id: 0x0100, data: [0x41, 0x42, 0x43] }]);
            const tape = await loadTapeFromData("test.uef", uef);
            expect(tape.curChunk).toBeDefined();
            expect(tape.curChunk.id).toBe(0x0100);
        });

        it("should parse origin chunks (0x0000)", async () => {
            const uef = makeUef([
                { id: 0x0000, data: [0x74, 0x65, 0x73, 0x74, 0x00] },
                { id: 0x0100, data: [0x41] },
            ]);
            const tape = await loadTapeFromData("test.uef", uef);
            expect(tape).not.toBeNull();
        });

        it("should support rewind", async () => {
            const uef = makeUef([{ id: 0x0100, data: [0x41] }]);
            const tape = await loadTapeFromData("test.uef", uef);
            tape.rewind();
            expect(tape.state).toBe(-1);
            expect(tape.count).toBe(0);
        });

        it("should poll data chunk and receive bytes", async () => {
            // Need two chunks: the constructor reads the first, poll processes it
            // and then reads the second to check for more data.
            const uef = makeUef([
                { id: 0x0110, data: [0x01, 0x00] }, // carrier tone, count=1
                { id: 0x0100, data: [0x41] },
            ]);
            const tape = await loadTapeFromData("test.uef", uef);
            let received = null;
            const acia = {
                setTapeCarrier: () => {},
                tone: () => {},
                receive: (b) => {
                    received = b;
                },
            };
            for (let i = 0; i < 30 && received === null; i++) {
                tape.poll(acia);
            }
            expect(received).toBe(0x41);
        });
    });

    describe("TapefileTape", () => {
        it("should start with carrier from header", async () => {
            // The first two bytes (0xFF 0x04) are read as the format detection,
            // but they also serve as the initial carrier signal when polled.
            // After seek(10), the tape reads from offset 10 onwards.
            const tapefile = makeTapefile([0xff, 0x04]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            let carrierSet = null;
            const acia = {
                setTapeCarrier: (val) => {
                    carrierSet = val;
                },
                receive: () => {},
                cr: 0x00,
            };
            tape.poll(acia);
            expect(carrierSet).toBe(true);
        });

        it("should receive regular bytes after rewind", async () => {
            // After rewind, stream seeks to offset 10 where our test data lives.
            const tapefile = makeTapefile([0x41]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            tape.rewind();
            let received = null;
            const acia = {
                setTapeCarrier: () => {},
                receive: (b) => {
                    received = b;
                },
                cr: 0x00,
            };
            tape.poll(acia);
            expect(received).toBe(0x41);
        });

        it("should escape 0xFF as 0xFF 0xFF after rewind", async () => {
            const tapefile = makeTapefile([0xff, 0xff]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            tape.rewind();
            let received = null;
            const acia = {
                setTapeCarrier: () => {},
                receive: (b) => {
                    received = b;
                },
                cr: 0x00,
            };
            tape.poll(acia);
            expect(received).toBe(0xff);
        });

        it("should handle end of carrier (0xFF 0x00) after rewind", async () => {
            const tapefile = makeTapefile([0xff, 0x00]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            tape.rewind();
            let carrierSet = null;
            const acia = {
                setTapeCarrier: (val) => {
                    carrierSet = val;
                },
                receive: () => {},
                cr: 0x00,
            };
            tape.poll(acia);
            expect(carrierSet).toBe(false);
        });

        it("should support rewind", async () => {
            const tapefile = makeTapefile([0x41, 0x42]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            const acia = { setTapeCarrier: () => {}, receive: () => {}, cr: 0x00 };
            tape.poll(acia);
            tape.rewind();
            let received = null;
            tape.poll({
                setTapeCarrier: () => {},
                receive: (b) => {
                    received = b;
                },
                cr: 0x00,
            });
            expect(received).toBe(0x41);
        });

        it("should return large cycle count at EOF", async () => {
            const tapefile = makeTapefile([]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            const cycles = tape.poll(mockAcia());
            expect(cycles).toBeGreaterThan(0);
        });
    });
});
