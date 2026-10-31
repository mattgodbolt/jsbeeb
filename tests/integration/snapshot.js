import { describe, expect, it } from "vitest";

import { createSnapshot, restoreSnapshot, snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import { copySnapshot } from "../../src/6502.js";
import { gzipCodec } from "../../src/archive.js";
import { Video } from "../../src/video.js";
import { AtomSoundChip, SoundChip } from "../../src/soundchip.js";
import {
    CpuCyclesPerField,
    CpuCyclesPerLine,
    expectSameFrom,
    LinesPerRowMode,
    makeAtomVideo,
    restoreInto,
    runCpuCycles,
} from "../helpers/atom-video.js";
import { WFNFile } from "../../src/mmc.js";
import { bootedTestMachine, mode7Text } from "./helpers.js";

const FbWidth = 1024;
const FbHeight = 768;
const Clear4Mode = 0xf0;
// CPU cycles: an arbitrary point in a field, and then about eighty lines of the 6847.
const AtomCyclesBeforeSnapshot = 12345;
const AtomCyclesAfterRestore = 5000;
const MidPictureLine = 94;
const LinesPerRow = 3;
const SnowAddr = 0x8123;
const MmcLoadAddress = 0x3000;
const MmcFileBytes = 2000;
const AtmNameBytes = 16;
const AtmHeaderBytes = AtmNameBytes + 6;

const withVideo = (model, options) =>
    new TestMachine(model, { video: new Video(false, FbWidth * FbHeight, () => {}, options) });
const OneEmulatedSecond = 2 * 1000 * 1000;
// A disc's tracks and original image, and an MMC card's files, are shared by reference on purpose, and nothing
// writes into them.
const SharedByReference = new Set(["tracks", "_originalImageData", "card"]);

function* ownedArrays(value) {
    if (ArrayBuffer.isView(value)) {
        yield value;
    } else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) if (!SharedByReference.has(key)) yield* ownedArrays(inner);
    }
}

// An AtoMMC file: the ATM header (name, load address, execution address, length), then the body.
function atmFile(name, loadAddress, body) {
    const file = new Uint8Array(AtmHeaderBytes + body.length);
    file.set(new TextEncoder().encode(name));
    const view = new DataView(file.buffer);
    view.setUint16(AtmNameBytes, loadAddress, true);
    view.setUint16(AtmNameBytes + 2, loadAddress, true);
    view.setUint16(AtmNameBytes + 4, body.length, true);
    file.set(body, AtmHeaderBytes);
    return file;
}

// Minutes and seconds differ from every other clock register, so reading the wrong one shows.
const ClockReadingEveryRegisterApart = Date.UTC(2026, 9, 31, 12, 34, 56);
const ReadClockForever = "10 REPEAT:T$=TIME$:UNTIL0";
const InstructionsIntoAnAccess = 3;
const AccessesSnapshotted = 30;
// 2MHz cycles, odd so that the points snapshotted fall at different places in the loop.
const RunOnCycles = 30011;

const stateOf = (machine) => JSON.parse(snapshotToJSON(createSnapshot(machine.processor, machine.model).state));

describe("save state round trip", () => {
    it("continues identically in a fresh machine restored through the gzipped file format", async () => {
        const original = withVideo();
        await original.initialise();
        await original.runUntilInput();
        await original.type('PRINT "SNAPSHOT"');
        await original.runUntilInput();
        expect(mode7Text(original)).toContain("SNAPSHOT");

        const json = snapshotToJSON(createSnapshot(original.processor, original.model));
        const snapshot = snapshotFromJSON(await gzipCodec.decompress(await gzipCodec.compress(json)));

        const restored = withVideo();
        await restored.initialise();
        restoreSnapshot(restored.processor, restored.model, snapshot);

        expect(mode7Text(restored)).toContain("SNAPSHOT");
        expect(restored.processor.pc).toBe(original.processor.pc);

        const cycles = 4 * 1000 * 1000;
        await original.runFor(cycles);
        await restored.runFor(cycles);

        expect(stateOf(restored)).toEqual(stateOf(original));
        expect(mode7Text(restored)).toContain("SNAPSHOT");
    });

    it("carries an Atom's picture on mid-field in a fresh machine restored from the file format", async () => {
        const atom = () => withVideo("Atom", { isAtom: true });
        const original = atom();
        await original.initialise();
        await original.runUntilInput();
        await original.type("CLEAR 4");
        await original.runUntilInput();
        await original.type("F.I=0TO6143 STEP 7;I?#8000=I;N.");
        await original.runUntilInput();
        await original.runFor(AtomCyclesBeforeSnapshot);
        expect(original.processor.video.video6847.lastmode).toBe(Clear4Mode);
        expect(original.readbyte(0x8000 + 700)).toBe(700 & 0xff);

        const restored = atom();
        await restored.initialise();
        const snapshot = snapshotFromJSON(snapshotToJSON(createSnapshot(original.processor, original.model)));
        restoreSnapshot(restored.processor, restored.model, snapshot);
        restored.processor.video.fb32.set(original.processor.video.fb32);

        await original.runFor(AtomCyclesAfterRestore);
        await restored.runFor(AtomCyclesAfterRestore);

        expect(restored.processor.video.video6847.snapshotState()).toEqual(
            original.processor.video.video6847.snapshotState(),
        );
        const fb = original.processor.video.fb32;
        expect(restored.processor.video.fb32.filter((pixel, i) => pixel !== fb[i]).length).toBe(0);
    });

    it("finishes an Atom's MMC load in a fresh machine restored part way through it", async () => {
        const body = Uint8Array.from({ length: MmcFileBytes }, (_, i) => (i * 7 + 3) & 0xff);
        const atomWithCard = async () => {
            const machine = await bootedTestMachine("Atom");
            machine.processor.atommc.SetMMCData([new WFNFile("/DATA", atmFile("DATA", MmcLoadAddress, body))]);
            return machine;
        };
        const loaded = (machine) => Uint8Array.from(body, (_, i) => machine.readbyte(MmcLoadAddress + i));
        const original = await atomWithCard();
        let reachedHalfway = false;
        const halfway = original.addBreakpoint("write", MmcLoadAddress + MmcFileBytes / 2, {}, () => {
            reachedHalfway = true;
        });
        await original.type('*LOAD "DATA"');
        await original.runFor(OneEmulatedSecond);
        halfway.remove();
        expect(reachedHalfway).toBe(true);
        expect(loaded(original)).not.toEqual(body);
        const snapshot = snapshotFromJSON(snapshotToJSON(createSnapshot(original.processor, original.model)));

        const restored = await atomWithCard();
        restoreSnapshot(restored.processor, restored.model, snapshot);
        await restored.runUntilInput();

        expect(loaded(restored)).toEqual(body);
    });

    it("carries a Master on from part way through a CMOS access, making none as it restores, from an older snapshot too", async () => {
        const machine = await bootedTestMachine("Master");
        const cpu = machine.processor;
        const { cmos } = cpu.sysvia;
        cmos.now = () => ClockReadingEveryRegisterApart;
        await machine.type(ReadClockForever);
        await machine.type("RUN");
        for (let access = 0; access < AccessesSnapshotted; ++access) {
            let instructions = 0;
            const intoAnAccess = cpu.debugInstruction.add(
                () => cmos.enabled && ++instructions === InstructionsIntoAnAccess,
            );
            await machine.runFor(OneEmulatedSecond);
            intoAnAccess.remove();
            const snapshot = cpu.snapshotState();
            const { enabled, isRead, addressSelect, dataSelect } = cmos.snapshotState();
            const bus = { enabled, isRead, addressSelect, dataSelect };
            expect(enabled).toBe(true);
            await machine.runFor(RunOnCycles);
            const original = stateOf(machine);
            const chipAfter = cmos.snapshotState();

            const { cmos: _, ...sysviaBeforeTheBusWasSaved } = snapshot.sysvia;
            cpu.restoreState({ ...snapshot, sysvia: sysviaBeforeTheBusWasSaved });
            expect(cmos.snapshotState()).toEqual({ ...chipAfter, ...bus });

            cpu.restoreState(snapshot);
            expect(cmos.snapshotState()).toEqual(snapshot.sysvia.cmos);
            await machine.runFor(RunOnCycles);
            expect(stateOf(machine)).toEqual(original);
        }
    });
});

describe.each([
    ["a B with a disc", "B-DFS1.2", {}, "discs/bcdtest.ssd"],
    ["a Master", "Master", {}, null],
    ["a Master with a co-processor", "Master", { tube: true }, null],
    ["an Atom", "Atom", {}, null],
])("snapshots taken into earlier ones' storage, for %s", (_, model, options, disc) => {
    const running = async () => {
        const video = new Video(false, FbWidth * FbHeight, () => {}, { isAtom: model === "Atom" });
        const soundChip = model === "Atom" ? new AtomSoundChip(() => {}) : new SoundChip(() => {});
        const machine = new TestMachine(model, { ...options, video, soundChip });
        await machine.initialise();
        if (disc) await machine.loadDisc(disc);
        await machine.runFor(OneEmulatedSecond);
        return machine;
    };

    it("are what a fresh snapshot is, and so are copies of them", async () => {
        const machine = await running();
        const cpu = machine.processor;
        const slot = cpu.snapshotState();
        await machine.runFor(OneEmulatedSecond);
        const fresh = snapshotToJSON(cpu.snapshotState());
        const taken = cpu.snapshotState({ into: slot });
        expect(taken.ram).toBe(slot.ram);
        expect(snapshotToJSON(taken)).toBe(fresh);
        const kept = copySnapshot(taken, cpu.snapshotState());
        // What the next snapshot into `taken` refills.
        for (const array of [taken.ram, taken.swram, taken.tube?.memory]) array?.fill(0x55);
        expect(snapshotToJSON(kept)).toBe(fresh);
    });

    it("leave the machine running exactly as it does untaken", async () => {
        const machine = await running();
        const cpu = machine.processor;
        const start = cpu.snapshotState();
        const frameCycles = machine.model.cyclesPerSecond / 50;
        const runFrames = async (capture) => {
            for (let frame = 0; frame < 50; frame++) {
                await machine.runFor(frameCycles);
                capture(frame);
            }
            return { state: snapshotToJSON(cpu.snapshotState()), picture: cpu.video.fb32.slice() };
        };
        const slots = [null, null, null];
        const captured = await runFrames((frame) => {
            slots[frame % slots.length] = cpu.snapshotState({ into: slots[frame % slots.length] });
        });
        cpu.restoreState(start);
        expect(await runFrames(() => {})).toEqual(captured);
    });

    it("never move the machine restored from them, as a restore keeps none of a snapshot's arrays", async () => {
        const machine = await running();
        const cpu = machine.processor;
        const slot = cpu.snapshotState();
        await machine.runFor(OneEmulatedSecond);
        cpu.restoreState(slot);
        const restored = snapshotToJSON(cpu.snapshotState());
        for (const array of ownedArrays(slot)) array.fill(0x55);
        expect(snapshotToJSON(cpu.snapshotState())).toBe(restored);
    });
});

describe("Video6847 snapshot", () => {
    it("carries on exactly as the original does from any cycle of a row mid-picture", () => {
        const rowStart = Math.floor(CpuCyclesPerField + CpuCyclesPerLine * MidPictureLine);
        const rowCycles = Math.ceil(CpuCyclesPerLine * LinesPerRow);
        for (let at = rowStart; at < rowStart + rowCycles; at++) {
            const original = makeAtomVideo();
            runCpuCycles(original.video, at);
            original.video.video6847.cpuAddrAccess(SnowAddr);

            const restored = restoreInto(original);
            expect(restored.video.video6847).toMatchObject({ cpuAddr: SnowAddr, lastmode: LinesPerRowMode });

            for (const { video } of [original, restored]) runCpuCycles(video, 2 * rowCycles);

            expect(original.vblanks).toEqual([]);
            expectSameFrom(original, restored);
        }
    });
});
