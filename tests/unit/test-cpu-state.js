import { describe, it, expect, beforeEach } from "vitest";
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
    const cpu = new Cpu6502(TEST_6502, {
        dbgr,
        video,
        soundChip,
        ddNoise: new FakeDdNoise(),
        music5000: new FakeMusic5000(),
        cmos: new Cmos(),
    });
    return cpu;
}

describe("Cpu6502 snapshotState / restoreState", () => {
    let cpu;

    beforeEach(async () => {
        cpu = makeCpu();
        await cpu.initialise();
    });

    it("should snapshot and restore CPU registers", () => {
        cpu.a = 0x42;
        cpu.x = 0x10;
        cpu.y = 0x20;
        cpu.s = 0xfd;
        cpu.pc = 0xd940;
        cpu.p.setFromByte(0xe5);

        const snapshot = cpu.snapshotState();

        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.a).toBe(0x42);
        expect(cpu2.x).toBe(0x10);
        expect(cpu2.y).toBe(0x20);
        expect(cpu2.s).toBe(0xfd);
        expect(cpu2.pc).toBe(0xd940);
        expect(cpu2.p.asByte()).toBe(0xe5 | 0x30); // bits 4,5 always set
    });

    it("should snapshot and restore interrupt state", () => {
        cpu._nmiLevel = true;
        cpu._nmiEdge = true;
        cpu.halted = true;

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        // interrupt is rebuilt by sub-component restores (VIA/ACIA), not saved directly
        expect(cpu2._nmiLevel).toBe(true);
        expect(cpu2._nmiEdge).toBe(true);
        expect(cpu2.halted).toBe(true);
    });

    it("should reconstruct interrupt flags from VIA state", () => {
        // Set up sysvia to have a pending interrupt
        cpu.sysvia.ier = 0x60;
        cpu.sysvia.ifr = 0x40;
        cpu.sysvia.updateIFR();
        expect(cpu.interrupt & 0x01).toBe(0x01);

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        // Interrupt should be reconstructed from VIA state
        expect(cpu2.interrupt & 0x01).toBe(0x01);
    });

    it("should snapshot and restore RAM contents", () => {
        // Write some data into RAM
        cpu.ramRomOs[0x0000] = 0xaa;
        cpu.ramRomOs[0x0100] = 0xbb;
        cpu.ramRomOs[0x1000] = 0xcc;
        cpu.ramRomOs[0x7fff] = 0xdd;

        const snapshot = cpu.snapshotState();

        // Verify RAM is in the snapshot
        expect(snapshot.ram[0x0000]).toBe(0xaa);
        expect(snapshot.ram[0x0100]).toBe(0xbb);
        expect(snapshot.ram[0x1000]).toBe(0xcc);
        expect(snapshot.ram[0x7fff]).toBe(0xdd);

        // Restore to a fresh CPU
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.ramRomOs[0x0000]).toBe(0xaa);
        expect(cpu2.ramRomOs[0x0100]).toBe(0xbb);
        expect(cpu2.ramRomOs[0x1000]).toBe(0xcc);
        expect(cpu2.ramRomOs[0x7fff]).toBe(0xdd);
    });

    it("should not include ROM data in the snapshot", () => {
        const snapshot = cpu.snapshotState();
        // RAM snapshot should only go up to romOffset (128KB), not include ROMs
        expect(snapshot.ram.length).toBe(cpu.romOffset);
    });

    it("should snapshot and restore memory control registers", () => {
        cpu.romsel = 5;
        cpu.videoDisplayPage = 0x8000;

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.romsel).toBe(5);
        expect(cpu2.videoDisplayPage).toBe(0x8000);
    });

    it("should snapshot and restore cycle counters", () => {
        cpu.currentCycles = 100000;
        cpu.targetCycles = 200000;
        cpu.cycleSeconds = 3.5;
        cpu.peripheralCycles = 50000;
        cpu.videoCycles = 75000;

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.currentCycles).toBe(100000);
        expect(cpu2.targetCycles).toBe(200000);
        expect(cpu2.cycleSeconds).toBe(3.5);
        expect(cpu2.peripheralCycles).toBe(50000);
        expect(cpu2.videoCycles).toBe(75000);
    });

    it("should snapshot and restore scheduler epoch via sub-component", () => {
        cpu.scheduler.polltime(50000);

        const snapshot = cpu.snapshotState();
        expect(snapshot.scheduler.epoch).toBe(50000);

        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);
        expect(cpu2.scheduler.epoch).toBe(50000);
    });

    it("should restore VIA state via sub-component delegation", () => {
        cpu.sysvia.ora = 0x77;
        cpu.sysvia.IC32 = 0xab;
        cpu.uservia.orb = 0x33;

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.sysvia.ora).toBe(0x77);
        expect(cpu2.sysvia.IC32).toBe(0xab);
        expect(cpu2.uservia.orb).toBe(0x33);
    });

    it("should produce isolated snapshots", () => {
        cpu.a = 0x42;
        cpu.ramRomOs[0x100] = 0xaa;

        const snapshot = cpu.snapshotState();

        cpu.a = 0x00;
        cpu.ramRomOs[0x100] = 0x00;

        expect(snapshot.a).toBe(0x42);
        expect(snapshot.ram[0x100]).toBe(0xaa);
    });

    it("should have scheduler tasks active after restore", () => {
        // VIA timers should have re-registered their tasks
        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        // The scheduler should have tasks registered (VIA timers at minimum)
        expect(cpu2.scheduler.headroom()).toBeLessThan(0xffffffff);
    });
});
