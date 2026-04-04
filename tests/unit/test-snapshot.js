import { describe, it, expect, beforeEach } from "vitest";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON, isSameModel } from "../../src/snapshot.js";
import { Cpu6502 } from "../../src/6502.js";
import { Video } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";
import { FakeDdNoise } from "../../src/ddnoise.js";
import { Cmos } from "../../src/cmos.js";
import { FakeMusic5000 } from "../../src/music5000.js";
import { TEST_6502 } from "../../src/models.js";
import { Disc, DiscConfig, loadSsd, crc32 } from "../../src/disc.js";
import { discFor } from "../../src/fdc.js";
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

        it("should round-trip drive state with disc loaded", () => {
            const scheduler = new Scheduler();
            const drive = new DiscDrive(0, scheduler);

            const disc = new Disc(true, new DiscConfig(), "test-drive");
            const ssdData = new Uint8Array(256 * 10);
            ssdData[0] = 0xab;
            loadSsd(disc, ssdData, false);
            drive.setDisc(disc);

            const state = drive.snapshotState();
            expect(state.disc).not.toBeNull();
            expect(state.disc.tracksUsed).toBeGreaterThan(0);

            // Restore into a new drive with a fresh disc
            const drive2 = new DiscDrive(1, scheduler);
            const disc2 = new Disc(true, new DiscConfig(), "test-drive2");
            loadSsd(disc2, new Uint8Array(256 * 10), false);
            drive2.setDisc(disc2);

            drive2.restoreState(state);
            // Disc data should match original
            const pulse = disc.getTrack(false, 0).pulses2Us[0];
            expect(drive2.disc.getTrack(false, 0).pulses2Us[0]).toBe(pulse);
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

        it("should round-trip disc Uint32Array through JSON base64 encoding", () => {
            // This tests the rewind-like path: full disc data through JSON.
            // snapshotState() retains tracks; snapshotToJSON encodes Uint32Arrays as base64.
            const disc = new Disc(true, new DiscConfig(), "test-json");
            const ssdData = new Uint8Array(256 * 10);
            ssdData[0] = 0xab;
            loadSsd(disc, ssdData, false);

            const discState = disc.snapshotState();
            const json = snapshotToJSON({ tracks: discState.tracks });
            const restored = snapshotFromJSON(json);

            const track = restored.tracks["false:0"];
            expect(track.pulses2Us).toBeInstanceOf(Uint32Array);
            expect(track.pulses2Us[0]).toBe(discState.tracks["false:0"].pulses2Us[0]);
        });

        it("should restore FDC state from save-to-file snapshot with disc pre-loaded", () => {
            // This tests the actual save-to-file path: createSnapshot strips tracks,
            // disc is pre-loaded before restore (simulating reloadSnapshotMedia).
            const disc = new Disc(true, new DiscConfig(), "test-save");
            const ssdData = new Uint8Array(256 * 10);
            ssdData[0] = 0xab;
            loadSsd(disc, ssdData, false);
            cpu.fdc.loadDisc(0, disc);

            const pulseBefore = disc.getTrack(false, 0).pulses2Us[0];

            // createSnapshot strips disc tracks (as it would for save-to-file)
            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);
            const restored = snapshotFromJSON(json);

            // Verify tracks were stripped
            expect(Object.keys(restored.state.fdc.drives[0].disc.tracks)).toHaveLength(0);

            // Pre-load the same disc (simulates reloadSnapshotMedia), then restore
            const cpu2 = makeCpu();
            const disc2 = new Disc(true, new DiscConfig(), "test-save");
            loadSsd(disc2, ssdData, false);
            cpu2.fdc.loadDisc(0, disc2);
            restoreSnapshot(cpu2, model, restored);

            // Disc data should come from the pre-loaded disc, not from the snapshot
            expect(cpu2.fdc.drives[0].disc.getTrack(false, 0).pulses2Us[0]).toBe(pulseBefore);
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

    describe("CRC32", () => {
        it("should compute CRC32 for known data", () => {
            // CRC32 of empty data is 0
            expect(crc32(new Uint8Array(0))).toBe(0);
            // CRC32 of "123456789" is 0xCBF43926
            const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
            expect(crc32(data)).toBe(0xcbf43926 | 0);
        });

        it("should produce different CRC32 for different data", () => {
            const data1 = new Uint8Array([1, 2, 3]);
            const data2 = new Uint8Array([1, 2, 4]);
            expect(crc32(data1)).not.toBe(crc32(data2));
        });
    });

    describe("Disc original image tracking", () => {
        it("should store original image data and CRC32 with setOriginalImage", () => {
            const disc = new Disc(true, new DiscConfig(), "test");
            const ssdData = new Uint8Array(256 * 10);
            ssdData[0] = 0x42;
            disc.setOriginalImage(ssdData);

            expect(disc.originalImageData).toBe(ssdData);
            expect(disc.originalImageCrc32).toBe(crc32(ssdData));
        });

        it("should only store CRC32 (not image data) via discFor", () => {
            const ssdData = new Uint8Array(256 * 10);
            ssdData[0] = 0x42;
            const loaded = discFor(null, "test.ssd", ssdData);

            expect(loaded.originalImageCrc32).toBe(crc32(ssdData));
            expect(loaded.originalImageData).toBeNull();
        });

        it("should track ever-dirty tracks cumulatively", () => {
            const disc = new Disc(true, new DiscConfig(), "test");
            const ssdData = new Uint8Array(256 * 10 * 3);
            loadSsd(disc, ssdData, false);

            // Write to track 0
            disc.writePulses(false, 0, 0, 0x12345678);
            disc.flushWrites();
            expect(disc._everDirtyTracks.has(0)).toBe(true);

            // Take a snapshot (clears _snapshotDirtyTracks but not _everDirtyTracks)
            disc.snapshotState();
            expect(disc._everDirtyTracks.has(0)).toBe(true);
            expect(disc._snapshotDirtyTracks.size).toBe(0);

            // Write to track 1
            disc.writePulses(false, 1, 0, 0xabcdef00);
            disc.flushWrites();

            // Both tracks should be in _everDirtyTracks
            expect(disc._everDirtyTracks.has(0)).toBe(true);
            expect(disc._everDirtyTracks.has(1)).toBe(true);
        });

        it("should preserve _everDirtyTracks through rewind restore", () => {
            const disc = new Disc(true, new DiscConfig(), "test-rewind");
            const ssdData = new Uint8Array(256 * 10 * 2);
            loadSsd(disc, ssdData, false);

            // Write to track 0
            disc.writePulses(false, 0, 0, 0x12345678);
            disc.flushWrites();

            // Take a rewind snapshot (in-memory, includes _everDirtyTracks)
            const rewindState = disc.snapshotState();
            expect(rewindState._everDirtyTracks).toBeInstanceOf(Set);
            expect(rewindState._everDirtyTracks.has(0)).toBe(true);

            // Restore from the rewind snapshot
            disc.restoreState(rewindState);

            // _everDirtyTracks should survive the restore
            expect(disc._everDirtyTracks.has(0)).toBe(true);

            // A subsequent save-to-file should include the dirty track
            cpu.fdc.loadDisc(0, disc);
            const snapshot = createSnapshot(cpu, model);
            expect(Object.keys(snapshot.state.fdc.drives[0].disc.dirtyTracks)).toHaveLength(1);
            expect(snapshot.state.fdc.drives[0].disc.dirtyTracks["false:0"]).toBeDefined();
        });
    });

    describe("Dirty track persistence in save-to-file snapshots", () => {
        it("should preserve dirty tracks in save-to-file snapshot", () => {
            const disc = new Disc(true, new DiscConfig(), "test-dirty");
            const ssdData = new Uint8Array(256 * 10 * 2);
            loadSsd(disc, ssdData, false);
            cpu.fdc.loadDisc(0, disc);

            // Write to track 0
            disc.writePulses(false, 0, 0, 0x12345678);
            disc.flushWrites();

            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);
            const restored = snapshotFromJSON(json);

            const discState = restored.state.fdc.drives[0].disc;
            // tracks should be empty (stripped for file save)
            expect(Object.keys(discState.tracks)).toHaveLength(0);
            // dirtyTracks should contain only track 0
            expect(Object.keys(discState.dirtyTracks)).toHaveLength(1);
            expect(discState.dirtyTracks["false:0"]).toBeDefined();
            expect(discState.dirtyTracks["false:0"].pulses2Us[0]).toBe(0x12345678);
        });

        it("should not include clean tracks in dirtyTracks", () => {
            const disc = new Disc(true, new DiscConfig(), "test-clean");
            const ssdData = new Uint8Array(256 * 10 * 2);
            loadSsd(disc, ssdData, false);
            cpu.fdc.loadDisc(0, disc);

            // No writes — snapshot should have empty dirtyTracks
            const snapshot = createSnapshot(cpu, model);
            const discState = snapshot.state.fdc.drives[0].disc;
            expect(Object.keys(discState.dirtyTracks)).toHaveLength(0);
        });

        it("should restore dirty tracks as overlay on base disc", () => {
            const disc = new Disc(true, new DiscConfig(), "test-overlay");
            const ssdData = new Uint8Array(256 * 10 * 2);
            ssdData[0] = 0xab;
            loadSsd(disc, ssdData, false);
            cpu.fdc.loadDisc(0, disc);

            const cleanPulse = disc.getTrack(false, 1).pulses2Us[0];

            // Write to track 0
            disc.writePulses(false, 0, 0, 0xdeadbeef);
            disc.flushWrites();

            // Save and JSON round-trip
            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);
            const restored = snapshotFromJSON(json);

            // Pre-load a fresh disc (simulates reloadSnapshotMedia)
            const cpu2 = makeCpu();
            const disc2 = new Disc(true, new DiscConfig(), "test-overlay");
            loadSsd(disc2, ssdData, false);
            cpu2.fdc.loadDisc(0, disc2);

            // Restore — dirty tracks should overlay the clean base
            restoreSnapshot(cpu2, model, restored);
            expect(cpu2.fdc.drives[0].disc.getTrack(false, 0).pulses2Us[0]).toBe(0xdeadbeef);
            // Clean track should still have base disc data
            expect(cpu2.fdc.drives[0].disc.getTrack(false, 1).pulses2Us[0]).toBe(cleanPulse);
        });
    });

    describe("Double-sided disc snapshot", () => {
        it("should round-trip dirty tracks on both sides", () => {
            const disc = new Disc(true, new DiscConfig(), "test-dsd");
            const dsdData = new Uint8Array(256 * 10 * 2 * 2); // 2 tracks, 2 sides
            loadSsd(disc, dsdData, true);
            cpu.fdc.loadDisc(0, disc);

            // Write to lower side track 0 and upper side track 0
            disc.writePulses(false, 0, 0, 0x11111111);
            disc.flushWrites();
            disc.writePulses(true, 0, 0, 0x22222222);
            disc.flushWrites();

            const snapshot = createSnapshot(cpu, model);
            const json = snapshotToJSON(snapshot);
            const restored = snapshotFromJSON(json);

            const discState = restored.state.fdc.drives[0].disc;
            expect(discState.dirtyTracks["false:0"]).toBeDefined();
            expect(discState.dirtyTracks["true:0"]).toBeDefined();
            expect(discState.dirtyTracks["false:0"].pulses2Us[0]).toBe(0x11111111);
            expect(discState.dirtyTracks["true:0"].pulses2Us[0]).toBe(0x22222222);

            // Restore onto a fresh disc
            const cpu2 = makeCpu();
            const disc2 = new Disc(true, new DiscConfig(), "test-dsd");
            loadSsd(disc2, dsdData, true);
            cpu2.fdc.loadDisc(0, disc2);

            restoreSnapshot(cpu2, model, restored);
            expect(cpu2.fdc.drives[0].disc.getTrack(false, 0).pulses2Us[0]).toBe(0x11111111);
            expect(cpu2.fdc.drives[0].disc.getTrack(true, 0).pulses2Us[0]).toBe(0x22222222);
        });
    });

    describe("Save-restore-write-save cycle", () => {
        it("should accumulate dirty tracks across save-to-file boundaries", () => {
            const ssdData = new Uint8Array(256 * 10 * 3);
            const disc1 = new Disc(true, new DiscConfig(), "test-cycle");
            loadSsd(disc1, ssdData, false);
            cpu.fdc.loadDisc(0, disc1);

            // Write to track 0, then save
            disc1.writePulses(false, 0, 0, 0xaaaaaaaa);
            disc1.flushWrites();
            const snapshot1 = createSnapshot(cpu, model);
            const json1 = snapshotToJSON(snapshot1);
            const restored1 = snapshotFromJSON(json1);

            // Restore onto a fresh CPU with base disc
            const cpu2 = makeCpu();
            const disc2 = new Disc(true, new DiscConfig(), "test-cycle");
            loadSsd(disc2, ssdData, false);
            cpu2.fdc.loadDisc(0, disc2);
            restoreSnapshot(cpu2, model, restored1);

            // Write to track 1 on the restored machine, then save again
            cpu2.fdc.drives[0].disc.writePulses(false, 1, 0, 0xbbbbbbbb);
            cpu2.fdc.drives[0].disc.flushWrites();
            const snapshot2 = createSnapshot(cpu2, model);

            const discState = snapshot2.state.fdc.drives[0].disc;
            // Both the originally-dirty track 0 and newly-dirty track 1 should be present
            expect(discState.dirtyTracks["false:0"]).toBeDefined();
            expect(discState.dirtyTracks["false:1"]).toBeDefined();
            expect(discState.dirtyTracks["false:0"].pulses2Us[0]).toBe(0xaaaaaaaa);
            expect(discState.dirtyTracks["false:1"].pulses2Us[0]).toBe(0xbbbbbbbb);
        });
    });

    describe("missing dirtyTracks graceful handling", () => {
        it("should restore a snapshot without dirtyTracks field", () => {
            const disc = new Disc(true, new DiscConfig(), "test-no-dirty");
            const ssdData = new Uint8Array(256 * 10);
            loadSsd(disc, ssdData, false);
            cpu.fdc.loadDisc(0, disc);

            const snapshot = createSnapshot(cpu, model);
            // Remove dirtyTracks to simulate an older snapshot
            for (const drive of snapshot.state.fdc.drives) {
                if (drive.disc) delete drive.disc.dirtyTracks;
            }

            const cpu2 = makeCpu();
            const disc2 = new Disc(true, new DiscConfig(), "test-v2");
            loadSsd(disc2, ssdData, false);
            cpu2.fdc.loadDisc(0, disc2);

            // Should not throw
            expect(() => restoreSnapshot(cpu2, model, snapshot)).not.toThrow();
        });
    });
});

describe("isSameModel", () => {
    it("should treat identical model names as compatible", () => {
        expect(isSameModel("BBC B with 8271 (DFS 1.2)", "BBC B with 8271 (DFS 1.2)")).toBe(true);
    });

    it("should treat synonyms of the same model as compatible", () => {
        expect(isSameModel("B-DFS1.2", "BBC B with DFS 1.2")).toBe(true);
        expect(isSameModel("B-DFS0.9", "BBC B with DFS 0.9")).toBe(true);
        expect(isSameModel("B-DFS0.9", "B")).toBe(true);
    });

    it("should not treat different BBC B 8271 DFS variants as compatible", () => {
        expect(isSameModel("B-DFS1.2", "B-DFS0.9")).toBe(false);
    });

    it("should not treat different BBC B 1770 variants as compatible", () => {
        expect(isSameModel("B1770", "B1770A")).toBe(false);
    });

    it("should not treat different BBC Master variants as compatible", () => {
        expect(isSameModel("Master", "MasterADFS")).toBe(false);
        expect(isSameModel("Master", "MasterANFS")).toBe(false);
        expect(isSameModel("MasterADFS", "MasterANFS")).toBe(false);
    });

    it("should not treat BBC B 8271 as compatible with BBC B 1770", () => {
        expect(isSameModel("B-DFS1.2", "B1770")).toBe(false);
    });

    it("should not treat BBC B as compatible with BBC Master", () => {
        expect(isSameModel("B-DFS1.2", "Master")).toBe(false);
    });

    it("should not treat unknown models as compatible", () => {
        expect(isSameModel("Nonexistent", "Master")).toBe(false);
    });
});
