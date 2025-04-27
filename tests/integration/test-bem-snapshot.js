"use strict";

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import { BemSnapshotConverter } from "../../src/bem-snapshot.js";
import { Flags } from "../../src/6502.js";

// Expected values from test.snp
const EXPECTED = {
    cpu: {
        a: 0xe0,
        x: 0x00,
        y: 0x0a,
        pc: 0xe593,
    },
    model: "BBC B w/8271+SWRAM",
};

describe("B-Em Snapshot Integration", () => {
    let sampleSnapshotData;
    let convertedSaveState;
    let reconvertedSnapshotData;

    beforeAll(() => {
        // Load the test.snp file
        sampleSnapshotData = new Uint8Array(fs.readFileSync("./tests/test.snp"));

        // Make sure the output directory exists
        if (!fs.existsSync("./tests/output")) {
            fs.mkdirSync("./tests/output", { recursive: true });
        }

        // Convert B-Em snapshot to jsbeeb SaveState
        convertedSaveState = BemSnapshotConverter.fromBemSnapshot(sampleSnapshotData);

        // Convert back to B-Em snapshot format
        reconvertedSnapshotData = BemSnapshotConverter.toBemSnapshot(convertedSaveState);

        // Save for inspection if needed
        fs.writeFileSync("./tests/output/reconverted.snp", reconvertedSnapshotData);
    });

    describe("B-Em to jsbeeb Conversion", () => {
        it("should extract correct CPU state", () => {
            const cpuState = convertedSaveState.getComponent("cpu");
            expect(cpuState).toBeDefined();
            expect(cpuState.a).toBe(EXPECTED.cpu.a);
            expect(cpuState.x).toBe(EXPECTED.cpu.x);
            expect(cpuState.y).toBe(EXPECTED.cpu.y);
            expect(cpuState.pc).toBe(EXPECTED.cpu.pc);

            // Verify CPU flags
            const flags = new Flags();
            flags.loadState(cpuState.p);
            expect(flags).toBeDefined();
        });

        it("should extract model information", () => {
            const modelState = convertedSaveState.getComponent("bem_model");
            expect(modelState).toBeDefined();
            expect(modelState.modelString).toContain(EXPECTED.model);
        });

        it("should extract VIA states", () => {
            const sysVia = convertedSaveState.getComponent("via_sys");

            // We don't know the exact values, but we can check the structure
            if (sysVia) {
                expect(typeof sysVia.ora).toBe("number");
                expect(typeof sysVia.orb).toBe("number");
                expect(typeof sysVia.ddra).toBe("number");
                expect(typeof sysVia.ddrb).toBe("number");
                expect(typeof sysVia.t1c).toBe("number");
                expect(typeof sysVia.t2c).toBe("number");

                // System VIA should have IC32
                expect(sysVia.IC32).toBeDefined();
            }

            const userVia = convertedSaveState.getComponent("via_user");
            if (userVia) {
                expect(typeof userVia.ora).toBe("number");
                expect(typeof userVia.orb).toBe("number");
                expect(typeof userVia.ddra).toBe("number");
                expect(typeof userVia.ddrb).toBe("number");
            }
        });
    });

    describe("jsbeeb to B-Em Conversion", () => {
        it("should create a valid B-Em snapshot", () => {
            expect(reconvertedSnapshotData.length).toBeGreaterThan(8);

            // Check header is correct
            const header = new TextDecoder().decode(reconvertedSnapshotData.slice(0, 8));
            expect(header).toBe("BEMSNAP3");
        });

        it("should include key sections in the converted snapshot", () => {
            // Helper to find a section by key
            function findSection(data, key) {
                let offset = 8; // Skip header
                while (offset < data.length) {
                    const sectionKey = String.fromCharCode(data[offset] & 0x7f);
                    if (sectionKey === key) {
                        return offset;
                    }

                    // Skip to next section
                    offset++;
                    const isCompressed = !!(data[offset - 1] & 0x80);
                    if (isCompressed) {
                        const size =
                            data[offset] |
                            (data[offset + 1] << 8) |
                            (data[offset + 2] << 16) |
                            (data[offset + 3] << 24);
                        offset += 4 + size;
                    } else {
                        const size = data[offset] | (data[offset + 1] << 8);
                        offset += 2 + size;
                    }
                }
                return -1;
            }

            // Check for required sections
            expect(findSection(reconvertedSnapshotData, "m")).toBeGreaterThan(0); // Model
            expect(findSection(reconvertedSnapshotData, "6")).toBeGreaterThan(0); // CPU
            expect(findSection(reconvertedSnapshotData, "S")).toBeGreaterThan(0); // SysVIA
            expect(findSection(reconvertedSnapshotData, "U")).toBeGreaterThan(0); // UserVIA
        });

        it("should preserve CPU state during roundtrip conversion", () => {
            // Find CPU section in reconverted data
            let offset = 8; // Skip header
            while (offset < reconvertedSnapshotData.length) {
                if ((reconvertedSnapshotData[offset] & 0x7f) === "6".charCodeAt(0)) {
                    break;
                }

                // Skip to next section
                offset++;
                const isCompressed = !!(reconvertedSnapshotData[offset - 1] & 0x80);
                if (isCompressed) {
                    const size =
                        reconvertedSnapshotData[offset] |
                        (reconvertedSnapshotData[offset + 1] << 8) |
                        (reconvertedSnapshotData[offset + 2] << 16) |
                        (reconvertedSnapshotData[offset + 3] << 24);
                    offset += 4 + size;
                } else {
                    const size = reconvertedSnapshotData[offset] | (reconvertedSnapshotData[offset + 1] << 8);
                    offset += 2 + size;
                }
            }

            if (offset < reconvertedSnapshotData.length) {
                // Skip section header (3 bytes)
                offset += 3;

                // Check CPU register values
                expect(reconvertedSnapshotData[offset]).toBe(EXPECTED.cpu.a); // A
                expect(reconvertedSnapshotData[offset + 1]).toBe(EXPECTED.cpu.x); // X
                expect(reconvertedSnapshotData[offset + 2]).toBe(EXPECTED.cpu.y); // Y
                expect(reconvertedSnapshotData[offset + 5] | (reconvertedSnapshotData[offset + 6] << 8)).toBe(
                    EXPECTED.cpu.pc,
                ); // PC
            } else {
                // Fail if CPU section not found
                expect(offset).toBeLessThan(reconvertedSnapshotData.length);
            }
        });
    });
});
