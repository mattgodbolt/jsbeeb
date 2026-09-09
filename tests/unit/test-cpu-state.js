import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fake6502 } from "../../src/fake6502.js";
import { NmiSource } from "../../src/nmi-source.js";
import { Econet } from "../../src/econet.js";
import { Video, FakeVideo } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";
import { machineSpec, nullIo } from "../../src/machine-spec.js";
import { findModel, TEST_6502 } from "../../src/models.js";

function makeCpu() {
    const fb32 = new Uint32Array(1024 * 768);
    const video = new Video(false, fb32, () => {});
    const soundChip = new SoundChip(() => {});
    return new TEST_6502.Cpu(TEST_6502, { ...nullIo({ video, soundChip }), config: machineSpec() });
}

// The 8271 seek command, selecting drive 1. The drive is empty, so it never reports ready and the
// command completes at once with an error, raising its completion NMI.
const SeekDrive1 = 0x69;
const FdcResetRegister = 2;

function sendSeekToMissingDrive(fdc) {
    fdc.write(0, SeekDrive1);
    fdc.write(1, 0);
}

/** Whether the CPU takes an NMI before its next instruction, consuming the edge if so. */
function takesNmi(cpu) {
    cpu.p.i = true;
    cpu.checkInt();
    if (!cpu.takeInt) return false;
    cpu.brk(true);
    return true;
}

const AdlcControl1 = 0xfea0;
const AdlcControl2 = 0xfea1;
const AdlcTxFifo = 0xfea2;
const RxTxInterruptsEnabled = 0x06;
const RxTxReset = 0xc0;
const PrioritisedStatus = 0x01;
const AdlcIrqFlag = 0x80;

// Releasing the resets with interrupts enabled reports two causes at once: TDRA, and via S2RQ
// the idle line.
function raiseAdlcIrq(cpu) {
    cpu.writeDevice(AdlcControl1, RxTxInterruptsEnabled);
    cpu.writeDevice(AdlcControl2, PrioritisedStatus);
    cpu.polltime(1);
}

function clearAdlcIrq(cpu) {
    cpu.writeDevice(AdlcControl1, RxTxReset);
    cpu.polltime(1);
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

    it("should restore a pending NMI edge, but not a level no device on the restored machine holds", async () => {
        cpu.setNmi(NmiSource.econet, true);
        cpu.halted = true;

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        await cpu2.initialise();
        cpu2.restoreState(snapshot);

        expect(snapshot.nmiLevel).toBe(true);
        expect(cpu2.nmi).toBe(false);
        expect(takesNmi(cpu2)).toBe(true);
        expect(cpu2.halted).toBe(true);
    });

    it("should reconstruct the NMI level from FDC state", () => {
        sendSeekToMissingDrive(cpu.fdc);
        expect(cpu.nmi).toBe(true);

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.nmi).toBe(true);
    });

    it("should not raise an NMI edge for a level the FDC restores", () => {
        sendSeekToMissingDrive(cpu.fdc);
        takesNmi(cpu);

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.nmi).toBe(true);
        expect(takesNmi(cpu2)).toBe(false);
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

describe("Cpu6502 NMI lines", () => {
    let cpu;

    beforeEach(() => {
        cpu = fake6502();
    });

    it("takes an NMI when the first source rises", () => {
        cpu.setNmi(NmiSource.fdc, true);

        expect(cpu.nmi).toBe(true);
        expect(takesNmi(cpu)).toBe(true);
    });

    it("does not take a second NMI for a source rising while another is held", () => {
        cpu.setNmi(NmiSource.fdc, true);
        takesNmi(cpu);

        cpu.setNmi(NmiSource.econet, true);

        expect(takesNmi(cpu)).toBe(false);
    });

    it("holds the line until every source has dropped", () => {
        cpu.setNmi(NmiSource.fdc, true);
        cpu.setNmi(NmiSource.econet, true);

        cpu.setNmi(NmiSource.fdc, false);
        expect(cpu.nmi).toBe(true);

        cpu.setNmi(NmiSource.econet, false);
        expect(cpu.nmi).toBe(false);
    });

    it("does not take an NMI for a source pulsing while another is held", () => {
        cpu.setNmi(NmiSource.fdc, true);
        cpu.setNmi(NmiSource.econet, true);
        takesNmi(cpu);

        cpu.setNmi(NmiSource.fdc, false);
        cpu.setNmi(NmiSource.fdc, true);

        expect(takesNmi(cpu)).toBe(false);
    });

    it("takes another NMI once every source has dropped and one rises again", () => {
        cpu.setNmi(NmiSource.fdc, true);
        cpu.setNmi(NmiSource.econet, true);
        takesNmi(cpu);
        cpu.setNmi(NmiSource.fdc, false);
        cpu.setNmi(NmiSource.econet, false);

        cpu.setNmi(NmiSource.econet, true);

        expect(takesNmi(cpu)).toBe(true);
    });

    it("tells each source whether its own line is up", () => {
        cpu.setNmi(NmiSource.econet, true);

        expect(cpu.nmiAsserted(NmiSource.econet)).toBe(true);
        expect(cpu.nmiAsserted(NmiSource.fdc)).toBe(false);
    });

    it("drops every source on reset", () => {
        cpu.setNmi(NmiSource.fdc, true);
        cpu.setNmi(NmiSource.econet, true);

        cpu.reset(true);

        expect(cpu.nmi).toBe(false);
        expect(takesNmi(cpu)).toBe(false);
    });

    it("leaves another device's line up when the 8271 aborts a command", () => {
        cpu.setNmi(NmiSource.econet, true);
        sendSeekToMissingDrive(cpu.fdc);

        cpu.fdc.write(FdcResetRegister, 1);

        expect(cpu.nmiAsserted(NmiSource.fdc)).toBe(false);
        expect(cpu.nmi).toBe(true);
    });
});

describe("Cpu6502 econet NMI line", () => {
    const StationIdRegister = 0xfe18;
    const NmiEnableRegister = 0xfe20;
    let cpu;
    let econet;

    beforeEach(async () => {
        econet = new Econet(1, TEST_6502.cyclesPerSecond);
        cpu = new TEST_6502.Cpu(TEST_6502, { ...nullIo(), econet, config: machineSpec() });
        await cpu.initialise();
    });

    it("follows the ADLC's IRQ flag", () => {
        raiseAdlcIrq(cpu);
        expect(econet.ADLC.status1 & AdlcIrqFlag).toBe(AdlcIrqFlag);
        expect(cpu.nmi).toBe(true);
        expect(takesNmi(cpu)).toBe(true);

        clearAdlcIrq(cpu);
        expect(econet.ADLC.status1 & AdlcIrqFlag).toBe(0);
        expect(cpu.nmi).toBe(false);
    });

    it("takes an NMI for each of two requests in turn", () => {
        raiseAdlcIrq(cpu);
        takesNmi(cpu);
        clearAdlcIrq(cpu);

        raiseAdlcIrq(cpu);

        expect(takesNmi(cpu)).toBe(true);
    });

    it("takes a second NMI when one prioritised cause clears while another stays", () => {
        raiseAdlcIrq(cpu);
        expect(takesNmi(cpu)).toBe(true);

        // Filling the transmit FIFO withdraws TDRA, leaving the S2RQ cause.
        for (let i = 0; i < 3; i++) cpu.writeDevice(AdlcTxFifo, 0x55);
        cpu.polltime(1);

        expect(econet.ADLC.status1 & AdlcIrqFlag).toBe(AdlcIrqFlag);
        expect(takesNmi(cpu)).toBe(true);
    });

    it("does not take a new NMI for a request restored with it", () => {
        raiseAdlcIrq(cpu);
        takesNmi(cpu);
        const snapshot = cpu.snapshotState();

        cpu.restoreState(snapshot);
        cpu.polltime(1);

        expect(cpu.nmi).toBe(true);
        expect(takesNmi(cpu)).toBe(false);
    });

    it("drops the line while reading the station id disables it, and raises it again on enable", () => {
        raiseAdlcIrq(cpu);
        takesNmi(cpu);

        cpu.readDevice(StationIdRegister);
        expect(cpu.nmi).toBe(false);

        cpu.readDevice(NmiEnableRegister);
        expect(cpu.nmi).toBe(true);
        expect(takesNmi(cpu)).toBe(true);
    });

    it("does not touch the disc controller's line", () => {
        cpu.setNmi(NmiSource.fdc, true);
        takesNmi(cpu);

        raiseAdlcIrq(cpu);
        expect(takesNmi(cpu)).toBe(false);

        cpu.readDevice(StationIdRegister);
        expect(cpu.nmi).toBe(true);
    });
});

describe("Cpu6502 cpuMultiplier", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const makeMultipliedCpu = (cpuMultiplier) => {
        const video = new FakeVideo();
        const videoCycles = vi.spyOn(video, "polltime").mockImplementation(() => {});
        const cpu = fake6502(null, { video, cpuMultiplier });
        const totalVideoCycles = () => videoCycles.mock.calls.reduce((total, [cycles]) => total + cycles, 0);
        return { cpu, totalVideoCycles };
    };

    it("runs peripherals and video at the CPU rate by default", () => {
        const { cpu, totalVideoCycles } = makeMultipliedCpu(undefined);

        cpu.polltime(1000);

        expect(cpu.scheduler.epoch).toBe(1000);
        expect(totalVideoCycles()).toBe(1000);
    });

    it("runs peripherals and video at half the CPU rate at multiplier 2", () => {
        const { cpu, totalVideoCycles } = makeMultipliedCpu(2);

        cpu.polltime(1000);

        expect(cpu.scheduler.epoch).toBe(500);
        expect(totalVideoCycles()).toBe(500);
    });

    it("runs peripherals and video at twice the CPU rate at multiplier 0.5", () => {
        const { cpu, totalVideoCycles } = makeMultipliedCpu(0.5);

        cpu.polltime(1000);

        expect(cpu.scheduler.epoch).toBe(2000);
        expect(totalVideoCycles()).toBe(2000);
    });

    it("takes the unscaled path at multiplier 1, passing every cycle straight through", () => {
        const { cpu } = makeMultipliedCpu(1);

        cpu.polltime(1);

        expect(cpu.scheduler.epoch).toBe(1);
    });

    it("accumulates fractional peripheral cycles rather than losing them", () => {
        const { cpu } = makeMultipliedCpu(2);

        cpu.polltime(1);
        expect(cpu.scheduler.epoch).toBe(0);

        cpu.polltime(1);
        expect(cpu.scheduler.epoch).toBe(1);
    });
});

describe("cycle counter rollover", () => {
    // The CPU keeps its cycle counters small by subtracting a second's worth
    // and bumping cycleSeconds. Consumers (the Atom speaker, test helpers)
    // reconstruct absolute time as cycleSeconds * clock + currentCycles, so
    // rolling over by the wrong amount makes emulated time jump backwards.
    const runAcrossASecond = async (model) => {
        const cpu = fake6502(model);
        await cpu.initialise();
        const absolute = () => cpu.cycleSeconds * model.cyclesPerSecond + cpu.currentCycles;
        let previous = absolute();
        let wentBackwards = false;
        // Bounded so a rollover that never happens fails rather than hangs.
        for (let chunk = 0; chunk < 50 && cpu.cycleSeconds < 1; ++chunk) {
            cpu.execute(100000);
            const now = absolute();
            if (now < previous) wentBackwards = true;
            previous = now;
        }
        return { cpu, wentBackwards, absolute: absolute() };
    };

    it("rolls a 2MHz machine over after two million cycles", async () => {
        const { cpu, wentBackwards, absolute } = await runAcrossASecond(TEST_6502);

        expect(cpu.cycleSeconds).toBe(1);
        expect(wentBackwards).toBe(false);
        expect(absolute).toBeGreaterThanOrEqual(2 * 1000 * 1000);
    });

    it("rolls a 1MHz machine over after one million cycles", async () => {
        const { cpu, wentBackwards, absolute } = await runAcrossASecond(findModel("Atom"));

        expect(cpu.cycleSeconds).toBe(1);
        expect(wentBackwards).toBe(false);
        expect(absolute).toBeLessThan(2 * 1000 * 1000);
    });
});

describe("the chips a machine names", () => {
    it("puts the keyboard and tape on the system VIA and ACIA of a BBC", () => {
        const cpu = fake6502(findModel("B-DFS1.2"));
        expect(cpu.keyboardInterface).toBe(cpu.sysvia);
        expect(cpu.tapeInterface).toBe(cpu.acia);
    });

    it("puts both on the PPIA of an Atom", () => {
        const cpu = fake6502(findModel("Atom"));
        expect(cpu.keyboardInterface).toBe(cpu.atomppia);
        expect(cpu.tapeInterface).toBe(cpu.atomppia);
    });
});
