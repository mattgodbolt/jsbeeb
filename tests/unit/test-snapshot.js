import { describe, it, expect, beforeEach } from "vitest";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON } from "../../src/snapshot.js";
import { Cpu6502 } from "../../src/6502.js";
import { Video } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";
import { FakeDdNoise } from "../../src/ddnoise.js";
import { Cmos } from "../../src/cmos.js";
import { FakeMusic5000 } from "../../src/music5000.js";
import { TEST_6502 } from "../../src/models.js";
import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { DiscDrive } from "../../src/disc-drive.js";
import { Scheduler } from "../../src/scheduler.js";
import { WdFdc } from "../../src/wd-fdc.js";

function makeCpu() {
    const fb32 = new Uint32Array(1024 * 768);
    const video = new Video(false, fb32, () => {});
    const soundChip = new SoundChip(() => {});
    const dbgr = { setCpu: () => {} };
    return new Cpu6502(TEST_6502, {
        dbgr,
        video,
        soundChip,
        ddNoise: new FakeDdNoise(),
        music5000: new FakeMusic5000(),
        cmos: new Cmos(),
    });
}

describe("Snapshot coordinator", () => {
    let cpu;
    const model = TEST_6502;

    beforeEach(async () => {
        cpu = makeCpu();
        await cpu.initialise();
    });

    describe("createSnapshot", () => {
        it("should create a snapshot with metadata", () => {
            const snapshot = createSnapshot(cpu, model);

            expect(snapshot.format).toBe("jsbeeb-snapshot");
            expect(snapshot.version).toBe(2);
            expect(snapshot.model).toBe(model.name);
            expect(snapshot.timestamp).toBeDefined();
            expect(snapshot.state).toBeDefined();
            expect(snapshot.state.a).toBeDefined();
            expect(snapshot.state.ram).toBeDefined();
        });
    });

    describe("restoreSnapshot", () => {
        it("should restore state from a snapshot", () => {
            cpu.a = 0x42;
            cpu.x = 0x10;
            cpu.ramRomOs[0x100] = 0xaa;

            const snapshot = createSnapshot(cpu, model);

            const cpu2 = makeCpu();
            restoreSnapshot(cpu2, model, snapshot);

            expect(cpu2.a).toBe(0x42);
            expect(cpu2.x).toBe(0x10);
            expect(cpu2.ramRomOs[0x100]).toBe(0xaa);
        });

        it("should throw on model mismatch", () => {
            const snapshot = createSnapshot(cpu, model);
            // Use a name that findModel won't resolve and doesn't match
            const otherModel = { name: "Completely Different Machine" };

            expect(() => restoreSnapshot(cpu, otherModel, snapshot)).toThrow(/Model mismatch/);
        });

        it("should throw on unknown format", () => {
            const snapshot = { format: "unknown", version: 1, model: model.name, state: {} };
            expect(() => restoreSnapshot(cpu, model, snapshot)).toThrow(/Unknown snapshot format/);
        });

        it("should throw on newer version", () => {
            const snapshot = createSnapshot(cpu, model);
            snapshot.version = 999;
            expect(() => restoreSnapshot(cpu, model, snapshot)).toThrow(/newer than supported/);
        });
    });

    describe("snapshotToJSON / snapshotFromJSON round-trip", () => {
        it("should round-trip a full snapshot through JSON", () => {
            cpu.a = 0x42;
            cpu.x = 0x10;
            cpu.y = 0x20;
            cpu.s = 0xfd;
            cpu.pc = 0xd940;
            cpu.ramRomOs[0x0000] = 0xaa;
            cpu.ramRomOs[0x100] = 0xbb;
            cpu.ramRomOs[0x7fff] = 0xcc;

            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);
            const restored = snapshotFromJSON(json);

            // Verify metadata survived
            expect(restored.format).toBe("jsbeeb-snapshot");
            expect(restored.version).toBe(2);
            expect(restored.model).toBe(model.name);

            // Verify TypedArrays were properly reconstructed
            expect(restored.state.ram).toBeInstanceOf(Uint8Array);
            expect(restored.state.ram[0x0000]).toBe(0xaa);
            expect(restored.state.ram[0x100]).toBe(0xbb);
            expect(restored.state.ram[0x7fff]).toBe(0xcc);

            // Verify scalar state survived
            expect(restored.state.a).toBe(0x42);
            expect(restored.state.x).toBe(0x10);
            expect(restored.state.y).toBe(0x20);
            expect(restored.state.s).toBe(0xfd);
            expect(restored.state.pc).toBe(0xd940);
        });

        it("should produce valid JSON", () => {
            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);

            // Should be valid JSON
            expect(() => JSON.parse(json)).not.toThrow();
        });

        it("should handle nested TypedArrays in sub-components", () => {
            cpu.soundChip.registers[0] = 0x123;
            cpu.video.regs[0] = 127;

            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);
            const restored = snapshotFromJSON(json);

            expect(restored.state.soundChip.registers).toBeInstanceOf(Uint16Array);
            expect(restored.state.soundChip.registers[0]).toBe(0x123);
            expect(restored.state.video.regs).toBeInstanceOf(Uint8Array);
            expect(restored.state.video.regs[0]).toBe(127);
        });

        it("should round-trip and restore correctly end-to-end", () => {
            cpu.a = 0x42;
            cpu.ramRomOs[0x200] = 0xdd;
            cpu.sysvia.ora = 0x55;

            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);
            const restored = snapshotFromJSON(json);

            const cpu2 = makeCpu();
            restoreSnapshot(cpu2, model, restored);

            expect(cpu2.a).toBe(0x42);
            expect(cpu2.ramRomOs[0x200]).toBe(0xdd);
            expect(cpu2.sysvia.ora).toBe(0x55);
        });
    });

    describe("v1 backward compatibility", () => {
        it("should restore a v1 snapshot without FDC field", () => {
            const snapshot = createSnapshot(cpu, model);
            // Simulate a v1 snapshot by removing FDC and setting version to 1
            snapshot.version = 1;
            delete snapshot.state.fdc;

            const cpu2 = makeCpu();
            // Should not throw — FDC keeps its current state
            expect(() => restoreSnapshot(cpu2, model, snapshot)).not.toThrow();
        });
    });

    describe("FDC snapshot", () => {
        it("should round-trip Intel FDC state", () => {
            const snapshot = createSnapshot(cpu, model);
            const fdcState = snapshot.state.fdc;

            expect(fdcState).toBeDefined();
            expect(fdcState.regs).toBeInstanceOf(Uint8Array);
            expect(fdcState.drives).toHaveLength(2);

            const cpu2 = makeCpu();
            restoreSnapshot(cpu2, model, snapshot);

            // Verify FDC scalar fields round-tripped
            const snapshot2 = createSnapshot(cpu2, model);
            expect(snapshot2.state.fdc.status).toBe(fdcState.status);
            expect(snapshot2.state.fdc.state).toBe(fdcState.state);
            expect(snapshot2.state.fdc.driveOut).toBe(fdcState.driveOut);
        });
    });

    describe("WD1770 FDC snapshot", () => {
        it("should round-trip WD1770 state including BigInt markDetector", () => {
            const scheduler = new Scheduler();
            const mockCpu = { model: { isMaster: true }, NMI: () => {} };
            const fdc = new WdFdc(mockCpu, scheduler, undefined, {});

            // Set markDetector to a non-zero BigInt to verify serialization
            fdc._markDetector = 0xaaaa448944894489n;
            fdc._trackRegister = 42;
            fdc._sectorRegister = 7;
            fdc._statusRegister = 0x80; // motor on

            const state = fdc.snapshotState();
            expect(typeof state.markDetector).toBe("string");
            expect(BigInt(state.markDetector)).toBe(0xaaaa448944894489n);

            // Restore into a fresh FDC
            const fdc2 = new WdFdc(mockCpu, scheduler, undefined, {});
            fdc2.restoreState(state);

            expect(fdc2._markDetector).toBe(0xaaaa448944894489n);
            expect(fdc2._trackRegister).toBe(42);
            expect(fdc2._sectorRegister).toBe(7);
            expect(fdc2._statusRegister).toBe(0x80);
        });
    });

    describe("DiscDrive snapshot", () => {
        it("should round-trip drive state", () => {
            const scheduler = new Scheduler();
            const drive = new DiscDrive(0, scheduler);

            const state = drive.snapshotState();
            expect(state.track).toBe(0);
            expect(state.spinning).toBe(false);
            expect(state.disc).toBeNull();

            const drive2 = new DiscDrive(1, scheduler);
            drive2.restoreState(state);

            expect(drive2.track).toBe(0);
            expect(drive2.spinning).toBe(false);
        });
    });

    describe("Disc snapshot", () => {
        it("should round-trip disc track data", () => {
            const disc = new Disc(true, new DiscConfig(), "test");
            // Write some data via the SSD loader to populate tracks
            const ssdData = new Uint8Array(256 * 10 * 2); // 2 tracks worth
            ssdData[0] = 0x42;
            loadSsd(disc, ssdData, false);

            const state = disc.snapshotState();
            expect(state.tracksUsed).toBeGreaterThan(0);

            // Modify the disc after snapshot
            const track0 = disc.getTrack(false, 0);
            const originalPulse = track0.pulses2Us[0];
            track0.pulses2Us[0] = 0xdeadbeef;

            // Restore should revert the change
            disc.restoreState(state);
            expect(disc.getTrack(false, 0).pulses2Us[0]).toBe(originalPulse);
        });

        it("should use structural sharing for clean tracks", () => {
            const disc = new Disc(true, new DiscConfig(), "test");
            const ssdData = new Uint8Array(256 * 10 * 2);
            loadSsd(disc, ssdData, false);

            // First snapshot copies all tracks
            const state1 = disc.snapshotState();

            // Second snapshot without any writes should share references
            const state2 = disc.snapshotState();

            const key = "false:0";
            // Same reference because track wasn't written between snapshots
            expect(state2.tracks[key]).toBe(state1.tracks[key]);
        });

        it("should copy dirty tracks in snapshot", () => {
            const disc = new Disc(true, new DiscConfig(), "test");
            const ssdData = new Uint8Array(256 * 10 * 2);
            loadSsd(disc, ssdData, false);

            const state1 = disc.snapshotState();

            // Write to track 0 — mark it dirty
            disc.writePulses(false, 0, 0, 0x12345678);
            disc.flushWrites();

            const state2 = disc.snapshotState();

            const key = "false:0";
            // Different reference because track was written
            expect(state2.tracks[key]).not.toBe(state1.tracks[key]);
            // But the new snapshot should have the written data
            expect(state2.tracks[key].pulses2Us[0]).toBe(0x12345678);

            // A clean track should still share
            const cleanKey = "false:1";
            expect(state2.tracks[cleanKey]).toBe(state1.tracks[cleanKey]);
        });
    });
});
