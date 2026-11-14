import { describe, expect, it } from "vitest";
import { AmxButtons, AmxMouse } from "../../src/amx-mouse.js";
import { UserVia } from "../../src/via.js";
import { Scheduler } from "../../src/scheduler.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import { ViaRegister } from "./helpers.js";

const { ORB, PCR, IFR } = ViaRegister;
const Cb1Int = 0x10;
const Cb2Int = 0x08;
const PcrCb1Cb2Rising = 0x50;
const X2 = 0x01;
const Y2 = 0x04;
const ButtonLines = 0xe0;
const StepsPerCount = 4;
const DriverPollTicks = 50;
const OneSecondTicks = 2_000_000;

function fittedMouse() {
    const scheduler = new Scheduler();
    const mouse = new AmxMouse(scheduler);
    const via = new UserVia({ interrupt: 0 }, scheduler, mouse);
    mouse.connect(via);
    return { scheduler, mouse, via };
}

/**
 * Software reading the mouse as AMX Design and J.G. Harston's driver do, polling rather than taking the interrupt:
 * each CB1 or CB2 flag is a count, its direction the X2 or Y2 line as port B is read to clear it.
 */
function runDriver({ scheduler, via }, ticks) {
    const seen = { x: 0, y: 0, xDirections: new Set(), yDirections: new Set(), bothAtOnce: false };
    for (let ran = 0; ran < ticks; ran += DriverPollTicks) {
        scheduler.polltime(DriverPollTicks);
        const flags = via.read(IFR) & (Cb1Int | Cb2Int);
        if (!flags) continue;
        const pins = via.read(ORB);
        seen.bothAtOnce ||= flags === (Cb1Int | Cb2Int);
        if (flags & Cb1Int) {
            seen.x += pins & X2 ? 1 : -1;
            seen.xDirections.add(!!(pins & X2));
        }
        if (flags & Cb2Int) {
            seen.y += pins & Y2 ? 1 : -1;
            seen.yDirections.add(!!(pins & Y2));
        }
    }
    return seen;
}

describe("AmxMouse", () => {
    it.each([
        ["right", [[40, 0]], 10, 0],
        ["left", [[-40, 0]], -10, 0],
        ["up", [[0, 40]], 0, 10],
        ["down", [[0, -40]], 0, -10],
        ["diagonally", [[40, -24]], 10, -6],
        [
            "there and back",
            [
                [16, 16],
                [-16, -16],
            ],
            0,
            0,
        ],
        ["in many small moves", Array(20).fill([2, -2]), 10, -10],
    ])("counts once per four steps moving %s, never flagging CB1 and CB2 together", (_, moves, x, y) => {
        const machine = fittedMouse();
        for (const [dx, dy] of moves) machine.mouse.move(dx, dy);
        const seen = runDriver(machine, OneSecondTicks);
        expect({ x: seen.x, y: seen.y, bothAtOnce: seen.bothAtOnce }).toEqual({ x, y, bothAtOnce: false });
    });

    it.each([
        ["falling", 0, 1, true],
        ["falling", 0, -1, false],
        ["rising", PcrCb1Cb2Rising, 1, false],
        ["rising", PcrCb1Cb2Rising, -1, true],
    ])("puts the direction line at the same level for every %s edge of a move %d", (_, pcr, sign, high) => {
        const machine = fittedMouse();
        machine.via.write(PCR, pcr);
        machine.mouse.move(sign * StepsPerCount * 5, sign * StepsPerCount * 5);
        const { xDirections, yDirections } = runDriver(machine, OneSecondTicks);
        expect({ x: [...xDirections], y: [...yDirections] }).toEqual({ x: [high], y: [high] });
    });

    it("moves no further until the software has cleared the flags, losing nothing", () => {
        const machine = fittedMouse();
        machine.mouse.move(40, 0);
        machine.scheduler.polltime(OneSecondTicks);
        expect(machine.via.read(IFR) & Cb1Int).toBe(Cb1Int);
        expect(runDriver(machine, OneSecondTicks).x).toBe(10);
    });

    it.each([
        ["no button", 0, 0],
        ["left", AmxButtons.left, 0x20],
        ["middle", AmxButtons.middle, 0x40],
        ["right", AmxButtons.right, 0x80],
        ["left and right", AmxButtons.left | AmxButtons.right, 0xa0],
    ])("pulls port B low for %s", (_, buttons, low) => {
        const { mouse, via } = fittedMouse();
        mouse.setButtons(buttons);
        expect(via.read(ORB) & ButtonLines).toBe(ButtonLines & ~low);
    });

    it("sits still with its buttons up while held, whatever the host does", () => {
        const machine = fittedMouse();
        const { mouse, via } = machine;
        mouse.hold(true);
        mouse.setButtons(AmxButtons.left);
        mouse.move(40, 40);
        expect(via.read(ORB) & ButtonLines).toBe(ButtonLines);
        expect(runDriver(machine, OneSecondTicks)).toMatchObject({ x: 0, y: 0 });
        mouse.hold(false);
        expect(via.read(ORB) & ButtonLines).toBe(ButtonLines & ~0x20);
    });

    it("forgets a move under way at power on", () => {
        const machine = fittedMouse();
        machine.mouse.move(40, 40);
        machine.scheduler.polltime(OneSecondTicks / 1000);
        machine.via.reset();
        machine.mouse.reset();
        expect(runDriver(machine, OneSecondTicks)).toMatchObject({ x: 0, y: 0 });
    });

    it("snapshots a move part way through", async () => {
        let scheduler;
        await expectSnapshotRoundTrips(
            () => {
                const machine = fittedMouse();
                scheduler = machine.scheduler;
                return machine.mouse;
            },
            (mouse) => {
                mouse.move(9, -7);
                scheduler.polltime(OneSecondTicks / 1000);
            },
        );
    });
});
