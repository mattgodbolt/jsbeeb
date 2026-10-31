import { afterEach, describe, expect, it, vi } from "vitest";

import { ReplayHistory } from "../../src/replay.js";
import { snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";
import { keyCodes } from "../../src/keymap.js";
import { mode7Text } from "./helpers.js";

const FbWidth = 1024;
const FbHeight = 768;
const RunningSeconds = 0.5;
const KeyHoldSeconds = 0.05;
const CatalogueSeconds = 2;
const ClockAtRecording = Date.UTC(2026, 9, 31, 12, 0, 0);
const ClockAtReplay = ClockAtRecording + 10 * 1000;
const WaitThenCatalogue = "10 A=GET\n20 *CAT";
const WaitThenClockAndCatalogue = "10 A=GET\n20 T$=TIME$\n30 *CAT";

async function booted(model) {
    const machine = new TestMachine(model, {
        video: new Video(false, FbWidth * FbHeight, () => {}),
        // As the page builds it, its sound rendered elsewhere from its events.
        soundChip: new SoundChip(null, { onEvent: () => {} }),
    });
    await machine.initialise();
    await machine.loadDisc("discs/bcdtest.ssd");
    await machine.runUntilInput();
    return machine;
}

// As the debugger's single step does.
function step(cpu) {
    cpu.targetCycles = cpu.currentCycles;
    cpu.execute(1);
}

const seconds = (machine, count) => machine.runFor(count * machine.model.cyclesPerSecond);

const machineNow = (machine) => ({
    state: snapshotToJSON(machine.processor.snapshotState()),
    keyboard: machine.processor.keyboardInterface.keyboardState(),
    picture: machine.processor.video.fb32.slice(),
});

afterEach(() => vi.restoreAllMocks());

// The Atom joins once a restored Atom runs on as it did (#1757).
describe.each([
    ["a B", "B-DFS1.2", WaitThenCatalogue],
    ["a Master", "Master", WaitThenClockAndCatalogue],
])("Stepping back on %s", (_, model, program) => {
    it.each([
        ["running alone", false],
        ["a key press, a disc access and a read of the clock", true],
    ])("then forward again ends where it began, replaying %s", async (_, withInputs) => {
        vi.spyOn(Date, "now").mockReturnValue(ClockAtRecording);
        const machine = await booted(model);
        const cpu = machine.processor;
        if (withInputs) {
            await machine.loadBasic(program);
            await machine.type("RUN");
            await machine.runUntilInput();
        }
        const history = new ReplayHistory(cpu);
        history.taken(cpu.snapshotState(), null);
        if (withInputs) {
            machine.keyDown(keyCodes.A);
            await seconds(machine, KeyHoldSeconds);
            machine.keyUp(keyCodes.A);
            await seconds(machine, CatalogueSeconds);
            expect(mode7Text(machine)).toContain("Drive 0");
        } else {
            await seconds(machine, RunningSeconds);
        }
        step(cpu);
        const before = machineNow(machine);
        Date.now.mockReturnValue(ClockAtReplay);

        expect(history.stepBack(false)).toBeNull();
        expect(machineNow(machine)).not.toEqual(before);
        step(cpu);
        expect(machineNow(machine)).toEqual(before);
    });

    it("refuses to step back across keys typed in part way through an instruction, leaving the machine alone", async () => {
        const machine = await booted(model);
        const cpu = machine.processor;
        const history = new ReplayHistory(cpu);
        history.taken(cpu.snapshotState(), null);
        await machine.type("REM");
        step(cpu);
        const before = machineNow(machine);

        expect(history.stepBack(false)).toMatch(/part way through an instruction/);
        expect(machineNow(machine)).toEqual(before);
    });
});
