import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fake6502 } from "../../src/fake6502.js";
import { NmiSource } from "../../src/6502.js";
import { Econet } from "../../src/econet.js";
import { Video, FakeVideo } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";
import { Music5000 } from "../../src/music5000.js";
import { machineSpec, nullIo } from "../../src/machine-spec.js";
import { findModel, TEST_6502, TEST_65C02 } from "../../src/models.js";
import { setNodeBasePath } from "../../src/loader.js";
import { hexbyte, hexword } from "../../src/hex.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

function makeCpu(model = TEST_6502) {
    const fb32 = new Uint32Array(1024 * 768);
    const video = new Video(false, fb32, () => {});
    const soundChip = new SoundChip(() => {});
    return new model.Cpu(model, { ...nullIo({ video, soundChip }), config: machineSpec() });
}

const SeekDrive1 = 0x69;
const WriteSpecialRegister = 0x3a;
const DriveOutRegister = 0x23;
const LoadHeadDrive1 = 0x48;
const FdcResetRegister = 2;

/** With the head loaded first, as the DFS does, the empty drive never reports ready and the seek fails at once. */
function sendSeekToMissingDrive(fdc) {
    fdc.write(0, WriteSpecialRegister);
    fdc.write(1, DriveOutRegister);
    fdc.write(1, LoadHeadDrive1);
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
const AdlcStatus1 = 0xfea0;
const AdlcIrqFlag = 0x80;
const RxTxInterruptsEnabled = 0x06;
const RxTxReset = 0xc0;
const PrioritisedStatus = 0x01;

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

const ProgramStart = 0x2000;
const ProgramCycles = 12345;
const RomSelect = 0xfe30;
const SysViaOrb = 0xfe40;
const SysViaOra = 0xfe41;
const SysViaDdrb = 0xfe42;
const SysViaT1CounterLow = 0xfe44;
const SysViaT1CounterHigh = 0xfe45;
const SysViaIer = 0xfe4e;
const IerSet = 0x80;
const Timer1Interrupt = 0x40;
const SysViaIrq = 0x01;
const SoundWriteDisabled = 0x08;
// SED; LDA #$42; LDX #$10; LDY #$20; PHA; STA $70; loop: DEX; JMP loop
const LoopProgram = [0xf8, 0xa9, 0x42, 0xa2, 0x10, 0xa0, 0x20, 0x48, 0x85, 0x70, 0xca, 0x4c, 0x0a, 0x20];

describe("Cpu6502 snapshotState / restoreState", () => {
    let cpu;

    beforeEach(async () => {
        cpu = makeCpu();
        await cpu.initialise();
    });

    it("round-trips a machine part way through a program, its FDC holding an NMI", async () => {
        await expectSnapshotRoundTrips(
            async () => {
                const machine = makeCpu();
                await machine.initialise();
                return machine;
            },
            (machine) => {
                machine.ramRomOs.set(LoopProgram, ProgramStart);
                machine.pc = ProgramStart;
                machine.execute(ProgramCycles);
                machine.writeDevice(RomSelect, 5);
                machine.writeDevice(SysViaDdrb, 0x0f);
                machine.writeDevice(SysViaOrb, SoundWriteDisabled);
                machine.writeDevice(SysViaOra, 0x0f);
                sendSeekToMissingDrive(machine.fdc);
            },
        );
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
        cpu.writeDevice(SysViaIer, IerSet | Timer1Interrupt);
        cpu.writeDevice(SysViaT1CounterLow, 2);
        cpu.writeDevice(SysViaT1CounterHigh, 0);
        cpu.polltime(10);
        expect(cpu.interrupt & SysViaIrq).toBe(SysViaIrq);

        const snapshot = cpu.snapshotState();
        const cpu2 = makeCpu();
        cpu2.restoreState(snapshot);

        expect(cpu2.interrupt & SysViaIrq).toBe(SysViaIrq);
    });

    it("should not include ROM data in the snapshot", () => {
        const snapshot = cpu.snapshotState();
        // RAM snapshot should only go up to romOffset (128KB), not include ROMs
        expect(snapshot.ram.length).toBe(cpu.romOffset);
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
        expect(cpu.readDevice(AdlcStatus1) & AdlcIrqFlag).toBe(AdlcIrqFlag);
        expect(cpu.nmi).toBe(true);
        expect(takesNmi(cpu)).toBe(true);

        clearAdlcIrq(cpu);
        expect(cpu.readDevice(AdlcStatus1) & AdlcIrqFlag).toBe(0);
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

        expect(cpu.readDevice(AdlcStatus1) & AdlcIrqFlag).toBe(AdlcIrqFlag);
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

describe("Cpu6502 file server", () => {
    const MissingRoot = "/nonexistent-jsbeeb-root";

    function makeEconetCpu() {
        const econet = new Econet(1, TEST_6502.cyclesPerSecond);
        return new TEST_6502.Cpu(TEST_6502, { ...nullIo(), econet, config: machineSpec() });
    }

    afterEach(() => setNodeBasePath(null));

    it("fails to initialise when the file server's files are missing", async () => {
        setNodeBasePath(MissingRoot);
        await expect(makeEconetCpu().initialise()).rejects.toThrow(/L3FS\.dat|scsi\.dat/);
    });

    it("restarts the file server on a hard reset without loading anything", async () => {
        const cpu = makeEconetCpu();
        await cpu.initialise();
        cpu.filestore.PC = 0x1234;
        cpu.filestore.scsi[0] ^= 0xff;
        const pristineFirstByte = cpu.filestore.scsi[0] ^ 0xff;

        setNodeBasePath(MissingRoot);
        cpu.reset(true);

        expect(cpu.filestore.PC).toBe(0x400);
        expect(cpu.filestore.ram[0x400]).toBe(cpu.filestore.l3fs[0]);
        expect(cpu.filestore.scsi[0]).toBe(pristineFirstByte);
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

    it.each([
        ["the CPU rate by default", undefined, 1000],
        ["half the CPU rate at multiplier 2", 2, 500],
        ["twice the CPU rate at multiplier 0.5", 0.5, 2000],
    ])("runs peripherals and video at %s", (_, cpuMultiplier, peripheralCycles) => {
        const { cpu, totalVideoCycles } = makeMultipliedCpu(cpuMultiplier);

        cpu.polltime(1000);

        expect(cpu.scheduler.epoch).toBe(peripheralCycles);
        expect(totalVideoCycles()).toBe(peripheralCycles);
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

describe("peeking at the hardware", () => {
    const BootCycles = 1000 * 1000;
    const PeekedCycles = 100 * 1000;
    const FredStart = 0xfc00;
    const SheilaStart = 0xfe00;
    const SheilaEnd = 0xff00;
    const SysViaBase = 0xfe40;
    const UserViaOrb = 0xfe60;
    const ViaRegisterCount = 16;
    const FdcResult = 0xfe81;
    const Acccon = 0xfe34;
    const AccconTst = 0x40;
    const EconetStationId = 0xfe18;
    const Music5000PageSelect = 0xfcff;
    const Music5000WaveRamPage = 0x30;
    const JimStart = 0xfd00;
    const Music5000WaveRamByte = JimStart + 0x12;
    const WaveByte = 0xa5;
    const CrtcAddress = 0xfe00;
    const CrtcData = 0xfe01;
    const CrtcStartAddressLow = 13;
    const StartAddressLow = 0x34;
    const AtomFdcStart = 0x0a00;
    const AtomDevicesStart = 0xb000;
    const AtomDevicesEnd = 0xc000;
    const AtomUserViaOrb = 0xb800;
    const BbcUnpeekable = [[0xfe10, 0xfe18]];
    const AtomUnpeekable = [
        [0xb000, 0xb008],
        [0xb400, 0xb410],
    ];

    async function bootedMachine(name) {
        const cpu = fake6502(findModel(name));
        await cpu.initialise();
        cpu.execute(BootCycles);
        return cpu;
    }

    // Each address is peeked before it is read, so a read's side effects can only show at later addresses.
    function peeksUnlikeReads(cpu, from, to, unpeekable = []) {
        const mismatches = [];
        for (let addr = from; addr < to; ++addr) {
            if (unpeekable.some(([start, end]) => addr >= start && addr < end)) continue;
            const peeked = cpu.peekmem(addr);
            const read = cpu.readmem(addr);
            if (peeked !== read) mismatches.push(`${hexword(addr)}: peeked ${hexbyte(peeked)}, read ${hexbyte(read)}`);
        }
        return mismatches;
    }

    for (const name of ["B-DFS1.2", "B1770", "Master"]) {
        it(`gives what a read gives at every I/O address but the serial ULA on ${name}`, async () => {
            const cpu = await bootedMachine(name);
            expect(peeksUnlikeReads(cpu, FredStart, SheilaEnd, BbcUnpeekable)).toEqual([]);
        });
    }

    it("gives what a read gives at every I/O address but the PPIA and MMC on an Atom", async () => {
        const cpu = await bootedMachine("Atom");
        expect(peeksUnlikeReads(cpu, AtomFdcStart, AtomFdcStart + 0x100)).toEqual([]);
        expect(peeksUnlikeReads(cpu, AtomDevicesStart, AtomDevicesEnd, AtomUnpeekable)).toEqual([]);
    });

    it("shows an idle user port as the next read would on a freshly reset machine", async () => {
        for (const [name, orb] of [
            ["B-DFS1.2", UserViaOrb],
            ["Atom", AtomUserViaOrb],
        ]) {
            const cpu = fake6502(findModel(name));
            await cpu.initialise();
            expect(cpu.peekmem(orb)).toBe(cpu.readmem(orb));
        }
    });

    it("leaves the 8271's result and its interrupt for the CPU", () => {
        const cpu = fake6502(findModel("B-DFS1.2"));
        sendSeekToMissingDrive(cpu.fdc);
        const peeked = cpu.peekmem(FdcResult);
        expect(cpu.nmi).toBe(true);
        expect(cpu.readmem(FdcResult)).toBe(peeked);
        expect(cpu.nmi).toBe(false);
    });

    it("shows the MOS through SHEILA while ACCCON's TST bit is set", async () => {
        const cpu = await bootedMachine("Master");
        cpu.writemem(Acccon, cpu.readmem(Acccon) | AccconTst);
        expect(cpu.peekmem(SysViaIer)).toBe(cpu.ramRomOs[cpu.osOffset + (SysViaIer & 0x3fff)]);
        expect(cpu.peekmem(SysViaIer)).toBe(cpu.readmem(SysViaIer));
    });

    it("shows the Econet station ID", () => {
        const cpu = fake6502(findModel("B-DFS1.2"), { econet: true });
        expect(cpu.peekmem(EconetStationId)).toBe(cpu.econet.stationId);
        expect(cpu.readmem(EconetStationId)).toBe(cpu.econet.stationId);
    });

    it("shows the CRTC's readable registers", () => {
        const cpu = makeCpu();
        cpu.writemem(CrtcAddress, CrtcStartAddressLow);
        cpu.writemem(CrtcData, StartAddressLow);
        expect(cpu.peekmem(CrtcData)).toBe(StartAddressLow);
        expect(cpu.readmem(CrtcData)).toBe(StartAddressLow);
    });

    it("shows the Music 5000's page select and wave RAM as a read does", () => {
        const model = findModel("B-DFS1.2");
        const cpu = new model.Cpu(model, {
            ...nullIo({ model }),
            music5000: new Music5000(() => {}),
            config: machineSpec({ hasMusic5000: true }),
        });
        cpu.writemem(Music5000PageSelect, Music5000WaveRamPage);
        cpu.writemem(Music5000WaveRamByte, WaveByte);
        expect(cpu.peekmem(Music5000PageSelect)).toBe(Music5000WaveRamPage);
        expect(cpu.peekmem(Music5000WaveRamByte)).toBe(cpu.readmem(Music5000WaveRamByte));
        expect(peeksUnlikeReads(cpu, Music5000PageSelect, JimStart + 0x100)).toEqual([]);
    });

    it("runs a B identically with every device peeked between instructions", async () => {
        const [peeked, untouched] = await Promise.all([bootedMachine("B-DFS1.2"), bootedMachine("B-DFS1.2")]);
        const end = peeked.currentCycles + PeekedCycles;
        while (peeked.currentCycles < end) {
            peeked.execute(1);
            for (let addr = SheilaStart; addr < SheilaEnd; ++addr) peeked.peekmem(addr);
        }
        untouched.execute(end - untouched.currentCycles);

        const state = (cpu) => ({
            registers: [cpu.a, cpu.x, cpu.y, cpu.s, cpu.pc, cpu.p.asByte(), cpu.currentCycles],
            ram: cpu.ramRomOs.slice(0, 0x8000),
            sysvia: Array.from({ length: ViaRegisterCount }, (_, reg) => cpu.readmem(SysViaBase + reg)),
        });
        expect(state(peeked)).toEqual(state(untouched));
    });
});

describe("Cpu6502 debug read hook", () => {
    const ProgramAddress = 0x2000;
    const ZeroPageAddress = 0x70;
    const AbsoluteAddress = 0x3000;
    const SubroutineAddress = 0x2010;
    // prettier-ignore
    const Program = [
        0xa5, ZeroPageAddress, // LDA &70
        0xad, 0x00, 0x30, // LDA &3000
        0xa9, 0x5a, // LDA #&5A
        0x48, // PHA
        0xa9, 0x00, // LDA #0
        0x68, // PLA
        0x20, 0x10, 0x20, // JSR &2010
        0x4c, 0x0e, 0x20, // JMP &200E
    ];
    const ReturnAddressLessOne = 0x200d;

    it.each([
        ["6502", TEST_6502],
        ["65C02", TEST_65C02],
    ])("is given the value each read on the %s returns", async (_name, model) => {
        const cpu = makeCpu(model);
        await cpu.initialise();
        Program.forEach((byte, i) => cpu.writemem(ProgramAddress + i, byte));
        cpu.writemem(SubroutineAddress, 0x60); // RTS
        cpu.writemem(ZeroPageAddress, 0x42);
        cpu.writemem(AbsoluteAddress, 0x99);
        const stackTop = 0x100 + cpu.s;
        cpu.pc = ProgramAddress;
        const reads = [];
        cpu.debugRead.add((addr, value) => {
            reads.push([addr, value]);
        });

        cpu.execute(100);

        expect(reads).toContainEqual([ZeroPageAddress, 0x42]);
        expect(reads).toContainEqual([AbsoluteAddress, 0x99]);
        expect(reads).toContainEqual([stackTop, 0x5a]);
        expect(reads).toContainEqual([stackTop - 1, ReturnAddressLessOne & 0xff]);
        expect(reads).toContainEqual([stackTop, ReturnAddressLessOne >>> 8]);
    });
});
