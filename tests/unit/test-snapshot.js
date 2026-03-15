import { describe, it, expect, beforeEach } from "vitest";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON } from "../../src/snapshot.js";
import { Cpu6502 } from "../../src/6502.js";
import { Video } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";
import { FakeDdNoise } from "../../src/ddnoise.js";
import { Cmos } from "../../src/cmos.js";
import { FakeMusic5000 } from "../../src/music5000.js";
import { TEST_6502 } from "../../src/models.js";

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
            expect(snapshot.version).toBe(1);
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
            const otherModel = { name: "Master 128" };

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
            expect(restored.version).toBe(1);
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
});
