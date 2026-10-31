import { afterEach, describe, expect, it, vi } from "vitest";

import { ReplayHistory, snapshotCycle } from "../../src/replay.js";
import { snapshotToJSON } from "../../src/snapshot.js";
import { Video } from "../../src/video.js";
import { AtomSoundChip, SoundChip } from "../../src/soundchip.js";
import { keyCodes } from "../../src/keymap.js";
import { bootedTestMachine, mode7Text } from "./helpers.js";
import { singleStep } from "../helpers/single-step.js";
import { executeUntilFrame } from "../../src/web/rewind-thumbnail.js";

const FbWidth = 1024;
const FbHeight = 768;
const KeyHoldSeconds = 0.05;
const CatalogueSeconds = 2;
const AroundAnInputSeconds = 0.1;
const ClockAtRecording = Date.UTC(2026, 9, 31, 12, 0, 0);
const ClockAtReplay = ClockAtRecording + 10 * 1000;
const WaitThenCatalogue = ["10 A=GET", "20 *CAT"];
const WaitThenClockAndCatalogue = ["10 A=GET", "20 T$=TIME$", "30 *CAT"];
const FirstSettingsCmosAddress = 14;
const LastCmosAddress = 63;
const CmosWrites = 1000;
// OSBYTE &A2 writes CMOS RAM, its X counting from the first settings byte.
const WriteCmosRepeatedly = [
    `10 FOR I%=1 TO ${CmosWrites}`,
    `20 A%=&A2:X%=${LastCmosAddress - FirstSettingsCmosAddress}:Y%=I%:CALL &FFF4`,
    "30 NEXT",
    "40 A=GET",
];
// Waits in the OS's OSRDCH for a key, then prints.
const AtomWaitThenPrint = ["10 LINK #FFE3", '20 P."DONE"'];
const ScratchAddress = 0x3000;
const AtomTextScreen = 0x8000;
const AtomTextScreenBytes = 512;
const AtomLetterOffset = 0x40;
const AdcFullScale = 0xffff;

async function booted(model, options) {
    const isAtom = model === "Atom";
    // The sound chip as the page builds it, its sound rendered elsewhere from its events.
    const onEvent = () => {};
    const machine = await bootedTestMachine(model, {
        video: new Video(false, FbWidth * FbHeight, () => {}, { isAtom }),
        soundChip: isAtom ? new AtomSoundChip(null, { onEvent }) : new SoundChip(null, { onEvent }),
        ...options,
    });
    if (!isAtom) await machine.loadDisc("discs/bcdtest.ssd");
    return machine;
}

/** A booted machine running BASIC's `lines`, waiting for a key. */
async function waitingIn(model, lines) {
    const machine = await booted(model);
    for (const line of [...lines, "RUN"]) await machine.type(line);
    await machine.runUntilInput();
    return machine;
}

const seconds = (machine, count) => machine.runFor(count * machine.model.cyclesPerSecond);

async function pressA(machine) {
    machine.keyDown(keyCodes.A);
    await seconds(machine, KeyHoldSeconds);
    machine.keyUp(keyCodes.A);
}

function historyFromHere(machine) {
    const history = new ReplayHistory(machine.processor);
    history.taken(machine.processor.snapshotState(), null);
    return history;
}

const machineNow = (machine) => ({
    state: snapshotToJSON(machine.processor.snapshotState()),
    keyboard: machine.processor.keyboardInterface.keyboardState(),
    picture: machine.processor.video.fb32.slice(),
});

/** Steps back and forward again, expecting to end exactly where it started. */
async function expectBackAndForthLandsWhereItWas(machine, history) {
    const cpu = machine.processor;
    singleStep(cpu);
    const before = machineNow(machine);
    expect(history.stepBack(false)).toBeNull();
    expect(machineNow(machine)).not.toEqual(before);
    singleStep(cpu);
    expect(machineNow(machine)).toEqual(before);
}

// An analogue source that reads differently every time.
function driftingSource() {
    let value = 0;
    return {
        getValue: () => (value = (value + 0x1234) & AdcFullScale),
        dispose: () => {},
    };
}

afterEach(() => vi.restoreAllMocks());

// The Atom's screen holds its letters as the 6847 draws them, A as 1.
const atomScreenHas = (machine, text) => {
    const screen = Array.from({ length: AtomTextScreenBytes }, (_, i) => machine.readbyte(AtomTextScreen + i));
    const codes = [...text].map((char) => char.charCodeAt(0) - AtomLetterOffset);
    return screen.some((_, at) => codes.every((code, i) => screen[at + i] === code));
};
const catalogued = (machine) => expect(mode7Text(machine)).toContain("Drive 0");

// What each runs once a key is pressed: on the B a disc access, on the Master its clock read too, and on the Atom a
// line printed. Only the BBCs read the FIRE buttons and the analogue port.
describe.each([
    ["a B", "B-DFS1.2", WaitThenCatalogue, catalogued, true],
    ["a Master", "Master", WaitThenClockAndCatalogue, catalogued, true],
    ["an Atom", "Atom", AtomWaitThenPrint, (machine) => expect(atomScreenHas(machine, "DONE")).toBe(true), false],
])("Stepping back on %s", (_, model, program, ran, readsBbcInputs) => {
    it("then forward again ends where it began, replaying a key press and what it set running", async () => {
        vi.spyOn(Date, "now").mockReturnValue(ClockAtRecording);
        const machine = await waitingIn(model, program);
        const history = historyFromHere(machine);
        await pressA(machine);
        await seconds(machine, CatalogueSeconds);
        ran(machine);
        Date.now.mockReturnValue(ClockAtReplay);
        await expectBackAndForthLandsWhereItWas(machine, history);
    });

    it.each([
        ["BREAK", (cpu) => cpu.setReset(true), (cpu) => cpu.setReset(false)],
        [
            "a soft reset",
            (cpu) => {
                cpu.inputLog.record({ kind: "reset" });
                cpu.reset(false);
            },
            () => {},
        ],
        ...(readsBbcInputs
            ? [
                  ["the gamepad's FIRE", (cpu) => cpu.sysvia.setGamepadFire(true, false), () => {}],
                  ["the mouse's FIRE", (cpu) => cpu.sysvia.setJoystickButton(0, true), () => {}],
                  [
                      "the analogue port's reads",
                      (cpu) => cpu.adconverter.setChannelSource(0, driftingSource()),
                      () => {},
                  ],
              ]
            : []),
        [
            "a byte edited in the memory panel",
            (cpu) => {
                cpu.inputLog.record({ kind: "write", address: ScratchAddress, value: 0x42 });
                cpu.writemem(ScratchAddress, 0x42);
            },
            () => {},
        ],
    ])("replays %s exactly", async (_, press, release) => {
        const machine = await booted(model);
        const cpu = machine.processor;
        const history = historyFromHere(machine);
        await seconds(machine, AroundAnInputSeconds);
        press(cpu);
        await seconds(machine, AroundAnInputSeconds);
        release(cpu);
        await seconds(machine, AroundAnInputSeconds);
        await expectBackAndForthLandsWhereItWas(machine, history);
    });

    it("starts from the keys held at a snapshot taken after they went down, once older inputs are folded away", async () => {
        const machine = await booted(model);
        const cpu = machine.processor;
        const history = historyFromHere(machine);
        const [oldest] = history.snapshots();
        machine.keyDown(keyCodes.SHIFT_LEFT);
        await seconds(machine, AroundAnInputSeconds);
        history.taken(cpu.snapshotState(), oldest);
        history.trim();
        await seconds(machine, AroundAnInputSeconds);
        machine.keyUp(keyCodes.SHIFT_LEFT);
        await seconds(machine, AroundAnInputSeconds);
        await expectBackAndForthLandsWhereItWas(machine, history);
    });

    it("forgets the future it stepped back from, so a different one replays exactly", async () => {
        const machine = await waitingIn(model, program);
        const history = historyFromHere(machine);
        await seconds(machine, AroundAnInputSeconds);
        await pressA(machine);
        await seconds(machine, AroundAnInputSeconds);
        expect(history.stepBack(false)).toBeNull();
        await seconds(machine, AroundAnInputSeconds);
        await expectBackAndForthLandsWhereItWas(machine, history);
    });

    it("lets go where it lands of a key let go of while stopped", async () => {
        const machine = await booted(model);
        const history = historyFromHere(machine);
        machine.keyDown(keyCodes.A);
        await seconds(machine, AroundAnInputSeconds);
        singleStep(machine.processor);
        machine.keyUp(keyCodes.A);
        const letGo = machine.processor.keyboardInterface.keyboardState();
        expect(history.stepBack(false)).toBeNull();
        expect(machine.processor.keyboardInterface.keyboardState()).toEqual(letGo);
    });

    it("starts afresh from a hard reset, never replaying from a snapshot taken before it", async () => {
        const machine = await booted(model);
        const cpu = machine.processor;
        const history = historyFromHere(machine);
        const [beforeReset] = history.snapshots();
        machine.reset(true);
        await seconds(machine, AroundAnInputSeconds);
        history.taken(cpu.snapshotState(), null);
        const resetAt = machine.elapsedCycles;
        await machine.runFor(
            snapshotCycle(cpu, beforeReset) - resetAt + machine.model.cyclesPerSecond * AroundAnInputSeconds,
        );
        await expectBackAndForthLandsWhereItWas(machine, history);
    });

    it.each([
        [
            "keys typed in part way through an instruction",
            async (machine) => machine.type("REM"),
            /part way through an instruction/,
        ],
        [
            "a change the log never saw",
            async (machine) => {
                await seconds(machine, AroundAnInputSeconds);
                machine.writebyte(ScratchAddress, 0x42);
            },
            /could not repeat/,
        ],
    ])("refuses to step back across %s, leaving the machine and its picture alone", async (_, change, why) => {
        const machine = await booted(model);
        const history = historyFromHere(machine);
        await change(machine);
        singleStep(machine.processor);
        const before = machineNow(machine);
        expect(history.stepBack(false)).toMatch(why);
        expect(machineNow(machine)).toEqual(before);
    });
});

describe("Replaying a Master's writes to its CMOS", () => {
    it.each([
        ["stepping back", ({ history }) => expect(history.stepBack(false)).toBeNull()],
        [
            "previewing a rewind",
            ({ cpu, start }) => {
                const live = cpu.snapshotState();
                cpu.restoreState(start);
                executeUntilFrame(cpu, cpu.video);
                cpu.restoreState(live);
            },
        ],
    ])("leaves the settings and the stored copy as the machine had them after %s", async (_, replay) => {
        const stored = [];
        const machine = await booted("Master", {
            cmosPersistence: { load: () => null, save: (store) => stored.push([...store]) },
        });
        const cpu = machine.processor;
        for (const line of [...WriteCmosRepeatedly, "RUN"]) await machine.type(line);
        const history = historyFromHere(machine);
        const start = cpu.snapshotState();
        await machine.runUntilInput();
        singleStep(cpu);
        const settings = [...cpu.sysvia.cmos.store];
        expect(settings[LastCmosAddress]).toBe(CmosWrites & 0xff);
        expect(stored.at(-1)).toEqual(settings);

        replay({ cpu, history, start });

        expect([cpu.sysvia.cmos.store, stored.at(-1)]).toEqual([settings, settings]);
    });
});
