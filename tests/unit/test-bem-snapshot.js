"use strict";

import { describe, it, expect, beforeEach } from "vitest";
import { BemSnapshotConverter } from "../../src/bem-snapshot.js";
import { SaveState } from "../../src/savestate.js";
import fs from "fs";
import { Flags } from "../../src/6502.js";

describe("BemSnapshotConverter", () => {
    let sampleSnapshotData;

    beforeEach(() => {
        // Load the test.snp file for use in tests
        sampleSnapshotData = new Uint8Array(fs.readFileSync("./tests/test.snp"));
    });

    describe("fromBemSnapshot", () => {
        it("should detect and validate B-Em snapshot header", () => {
            // Check valid header
            expect(() => {
                BemSnapshotConverter.fromBemSnapshot(sampleSnapshotData);
            }).not.toThrow();

            // Check invalid magic
            const invalidMagic = new Uint8Array(sampleSnapshotData);
            invalidMagic[0] = "X".charCodeAt(0); // Change first letter of magic
            expect(() => {
                BemSnapshotConverter.fromBemSnapshot(invalidMagic);
            }).toThrow("Invalid B-Em snapshot file");

            // Check invalid version
            const invalidVersion = new Uint8Array(sampleSnapshotData);
            invalidVersion[7] = "9".charCodeAt(0); // Set version to 9
            expect(() => {
                BemSnapshotConverter.fromBemSnapshot(invalidVersion);
            }).toThrow("Unsupported B-Em snapshot version");
        });

        it("should extract model info", () => {
            const saveState = BemSnapshotConverter.fromBemSnapshot(sampleSnapshotData);
            const modelData = saveState.getComponent("bem_model");

            expect(modelData).toBeDefined();
            // The test.snp has a model string of "BBC B w/8271+SWRAM"
            expect(modelData.modelString).toContain("BBC B");
        });

        it("should extract CPU state", () => {
            const saveState = BemSnapshotConverter.fromBemSnapshot(sampleSnapshotData);
            const cpuState = saveState.getComponent("cpu");

            expect(cpuState).toBeDefined();
            expect(cpuState.a).toBeDefined();
            expect(cpuState.x).toBeDefined();
            expect(cpuState.y).toBeDefined();
            expect(cpuState.s).toBeDefined();
            expect(cpuState.pc).toBeDefined();
            expect(cpuState.p).toBeDefined();
        });

        it("should extract VIA states when available", () => {
            const saveState = BemSnapshotConverter.fromBemSnapshot(sampleSnapshotData);

            // System VIA
            const sysVia = saveState.getComponent("via_sys");
            if (sysVia) {
                expect(sysVia.ora).toBeDefined();
                expect(sysVia.orb).toBeDefined();
                expect(sysVia.ddra).toBeDefined();
                expect(sysVia.ddrb).toBeDefined();
                expect(sysVia.t1c).toBeDefined();
                expect(sysVia.t2c).toBeDefined();
                expect(sysVia.IC32).toBeDefined();
            }

            // User VIA
            const userVia = saveState.getComponent("via_user");
            if (userVia) {
                expect(userVia.ora).toBeDefined();
                expect(userVia.orb).toBeDefined();
                expect(userVia.ddra).toBeDefined();
                expect(userVia.ddrb).toBeDefined();
                expect(userVia.t1c).toBeDefined();
                expect(userVia.t2c).toBeDefined();
            }
        });

        it("should handle different snapshot versions", () => {
            // Create a version 1 snapshot
            const v1Snapshot = new Uint8Array(sampleSnapshotData);
            v1Snapshot[7] = "1".charCodeAt(0);

            // Should not throw when parsing version 1
            expect(() => {
                BemSnapshotConverter.fromBemSnapshot(v1Snapshot);
            }).not.toThrow();

            // Create a version 2 snapshot
            const v2Snapshot = new Uint8Array(sampleSnapshotData);
            v2Snapshot[7] = "2".charCodeAt(0);

            // Should not throw when parsing version 2
            expect(() => {
                BemSnapshotConverter.fromBemSnapshot(v2Snapshot);
            }).not.toThrow();
        });
    });

    describe("toBemSnapshot", () => {
        let mockSaveState;

        beforeEach(() => {
            // Create a mock SaveState with enough data to generate a B-Em snapshot
            mockSaveState = new SaveState();

            // Add CPU state
            const cpuState = {
                a: 0x01,
                x: 0x02,
                y: 0x03,
                s: 0xfd,
                pc: 0xc000,
                p: new Flags().saveState(),
                interrupt: 0,
                _nmiLevel: false,
                _nmiEdge: false,
                takeInt: false,
                halted: false,
            };
            mockSaveState.addComponent("cpu", cpuState);

            // Add system VIA state
            const sysViaState = {
                ora: 0x00,
                orb: 0x00,
                ira: 0x00,
                irb: 0x00,
                ddra: 0xff,
                ddrb: 0xff,
                sr: 0x00,
                acr: 0x00,
                pcr: 0x00,
                ifr: 0x00,
                ier: 0x00,
                t1c: 1000,
                t1l: 1000,
                t2c: 1000,
                t2l: 1000,
                t1hit: 0,
                t2hit: 0,
                ca1: 0,
                ca2: 0,
                cb1: 0,
                cb2: 0,
            };
            mockSaveState.addComponent("via_sys", sysViaState);
            mockSaveState.addComponent("sysvia_ext", { IC32: 0x00 });

            // Add user VIA state
            const userViaState = { ...sysViaState };
            mockSaveState.addComponent("via_user", userViaState);

            // Add video state
            const videoState = {
                scrx: 0,
                scry: 0,
                oddclock: 0,
                vidclocks: 0,
            };
            mockSaveState.addComponent("video", videoState);

            // Add CRTC state
            const crtcState = {
                registers: new Array(18).fill(0),
                vc: 0,
                sc: 0,
                hc: 0,
                ma: 0,
                maback: 0,
            };
            mockSaveState.addComponent("crtc", crtcState);

            // Add video ULA state
            const videoUlaState = {
                controlReg: 0,
                palette: new Array(16).fill(0),
            };
            mockSaveState.addComponent("video_ula", videoUlaState);
        });

        it("should create a valid B-Em snapshot header", () => {
            const result = BemSnapshotConverter.toBemSnapshot(mockSaveState);

            // Check for "BEMSNAP3" header
            expect(result.length).toBeGreaterThan(8);
            const header = new TextDecoder().decode(result.slice(0, 8));
            expect(header).toBe("BEMSNAP3");
        });

        it("should include sections for main components", () => {
            const result = BemSnapshotConverter.toBemSnapshot(mockSaveState);

            // After header (8 bytes), look for section keys
            // Note: This is fragile and depends on the order sections are created

            // Model section - key 'm'
            expect(result[8]).toBe("m".charCodeAt(0));

            // Skip the model section and look for CPU - key '6'
            let offset = 8 + 3 + result[9] + (result[10] << 8); // Header + section size
            expect(String.fromCharCode(result[offset])).toBe("6");

            // Skip to the next section - System VIA - key 'S'
            offset += 3 + result[offset + 1] + (result[offset + 2] << 8);
            expect(String.fromCharCode(result[offset])).toBe("S");

            // Skip to the next section - User VIA - key 'U'
            offset += 3 + result[offset + 1] + (result[offset + 2] << 8);
            expect(String.fromCharCode(result[offset])).toBe("U");
        });

        it("should correctly encode CPU state", () => {
            // Set specific CPU values to check
            mockSaveState.getComponent("cpu").a = 0x42;
            mockSaveState.getComponent("cpu").x = 0x69;
            mockSaveState.getComponent("cpu").pc = 0xdead;

            const result = BemSnapshotConverter.toBemSnapshot(mockSaveState);

            // Find CPU section
            let offset = 8; // Skip header
            while (offset < result.length && String.fromCharCode(result[offset] & 0x7f) !== "6") {
                offset += 3 + result[offset + 1] + (result[offset + 2] << 8);
            }

            // Skip section header
            offset += 3;

            // Check CPU state values
            expect(result[offset]).toBe(0x42); // A
            expect(result[offset + 1]).toBe(0x69); // X
            expect(result[offset + 5]).toBe(0xad); // PC low
            expect(result[offset + 6]).toBe(0xde); // PC high
        });

        it("should note limitations for memory compression", () => {
            BemSnapshotConverter.toBemSnapshot(mockSaveState);

            // Check if metadata has note about memory compression
            expect(mockSaveState.metadata.conversionNote).toContain("Memory export");
            expect(mockSaveState.metadata.conversionNote).toContain("zlib");
        });
    });

    describe("CPU state conversion", () => {
        it("should correctly convert status flags between formats", () => {
            // Create a SaveState with specific CPU flags
            const saveState = new SaveState();
            const flags = new Flags();
            flags.n = true;
            flags.v = false;
            flags.d = true;
            flags.i = true;
            flags.z = false;
            flags.c = true;

            saveState.addComponent("cpu", {
                a: 0,
                x: 0,
                y: 0,
                s: 0,
                pc: 0,
                p: flags.saveState(),
                interrupt: 0,
                _nmiLevel: false,
                _nmiEdge: false,
                takeInt: false,
                halted: false,
            });

            // Convert to B-Em format
            const bemData = BemSnapshotConverter.toBemSnapshot(saveState);

            // Find the CPU section
            let offset = 8; // Skip header
            while (offset < bemData.length && String.fromCharCode(bemData[offset] & 0x7f) !== "6") {
                offset += 3 + bemData[offset + 1] + (bemData[offset + 2] << 8);
            }

            // Get the flags byte (index 3 in CPU state)
            offset += 3 + 3; // Skip section header + a, x, y
            const bemFlags = bemData[offset];

            // B-Em flags should have:
            // - N flag set (bit 7)
            // - V flag clear (bit 6)
            // - Bit 5 always set
            // - B flag always set (bit 4)
            // - D flag set (bit 3)
            // - I flag set (bit 2)
            // - Z flag clear (bit 1)
            // - C flag set (bit 0)
            expect(bemFlags & 0x80).not.toBe(0); // N
            expect(bemFlags & 0x40).toBe(0); // V
            expect(bemFlags & 0x20).not.toBe(0); // Bit 5
            expect(bemFlags & 0x10).not.toBe(0); // B
            expect(bemFlags & 0x08).not.toBe(0); // D
            expect(bemFlags & 0x04).not.toBe(0); // I
            expect(bemFlags & 0x02).toBe(0); // Z
            expect(bemFlags & 0x01).not.toBe(0); // C

            // Now convert back to jsbeeb format
            // Create a new SaveState from the BemSnapshot
            const convertedState = BemSnapshotConverter.fromBemSnapshot(bemData);
            const convertedFlags = new Flags();
            convertedFlags.loadState(convertedState.getComponent("cpu").p);

            // Check the flags match the original
            expect(convertedFlags.n).toBe(true);
            expect(convertedFlags.v).toBe(false);
            expect(convertedFlags.d).toBe(true);
            expect(convertedFlags.i).toBe(true);
            expect(convertedFlags.z).toBe(false);
            expect(convertedFlags.c).toBe(true);
        });
    });
});
