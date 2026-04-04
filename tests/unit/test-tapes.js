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

// Poll a tape until a byte is received or maxPolls is reached.
function pollUntilReceived(tape, maxPolls = 30) {
    let received = null;
    const acia = {
        setTapeCarrier: () => {},
        tone: () => {},
        receive: (b) => {
            received = b;
        },
        cr: 0x00,
    };
    for (let i = 0; i < maxPolls && received === null; i++) {
        tape.poll(acia);
    }
    return received;
}

describe("tapes", () => {
    describe("loadTapeFromData", () => {
        it("should detect UEF format", async () => {
            const uef = makeUef([{ id: 0x0100, data: [0x41] }]);
            const tape = await loadTapeFromData("test.uef", uef);
            expect(tape).not.toBeNull();
            // Verify it behaves as a UEF tape: poll should not throw
            expect(() => tape.poll(mockAcia())).not.toThrow();
        });

        it("should detect tapefile format", async () => {
            const tapefile = makeTapefile();
            const tape = await loadTapeFromData("test.tape", tapefile);
            expect(tape).not.toBeNull();
            // First poll reads the 0xFF 0x04 carrier header and returns 5s delay
            expect(tape.poll(mockAcia())).toBe(5 * 2 * 1000 * 1000);
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
        it("should poll data chunk and receive bytes", async () => {
            // Include a leading chunk because UefTape pre-reads one in the
            // constructor, and the first poll advances to the next chunk.
            const uef = makeUef([
                { id: 0x0110, data: [0x01, 0x00] }, // carrier tone, count=1
                { id: 0x0100, data: [0x41] },
            ]);
            const tape = await loadTapeFromData("test.uef", uef);
            expect(pollUntilReceived(tape)).toBe(0x41);
        });

        it("should consume origin chunks without error", async () => {
            const uef = makeUef([
                { id: 0x0000, data: [0x74, 0x65, 0x73, 0x74, 0x00] }, // "test\0"
                { id: 0x0100, data: [0x41] },
            ]);
            const tape = await loadTapeFromData("test.uef", uef);
            // Poll past the origin chunk and receive data from the next chunk
            expect(pollUntilReceived(tape)).toBe(0x41);
        });

        it("should support rewind and replay", async () => {
            const uef = makeUef([
                { id: 0x0110, data: [0x01, 0x00] },
                { id: 0x0100, data: [0x41] },
            ]);
            const tape = await loadTapeFromData("test.uef", uef);
            expect(pollUntilReceived(tape)).toBe(0x41);

            tape.rewind();
            expect(pollUntilReceived(tape)).toBe(0x41);
        });
    });

    describe("TapefileTape", () => {
        it("should start with carrier from header", async () => {
            // Format detection uses readByte(0/1) without advancing the stream,
            // so the first poll still reads the 0xFF 0x04 carrier header.
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
            const tapefile = makeTapefile([0x41]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            tape.rewind();
            expect(pollUntilReceived(tape, 1)).toBe(0x41);
        });

        it("should escape 0xFF as 0xFF 0xFF after rewind", async () => {
            const tapefile = makeTapefile([0xff, 0xff]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            tape.rewind();
            expect(pollUntilReceived(tape, 1)).toBe(0xff);
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

        it("should support rewind and replay", async () => {
            const tapefile = makeTapefile([0x41, 0x42]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            tape.rewind();
            expect(pollUntilReceived(tape, 1)).toBe(0x41);

            tape.rewind();
            expect(pollUntilReceived(tape, 1)).toBe(0x41);
        });

        it("should return large cycle count at EOF", async () => {
            const tapefile = makeTapefile([0x41, 0x42, 0x43]);
            const tape = await loadTapeFromData("test.tape", tapefile);
            tape.rewind();
            // Consume all bytes
            for (let i = 0; i < 3; i++) tape.poll(mockAcia());
            expect(tape.poll(mockAcia())).toBe(100000);
        });
    });
});
