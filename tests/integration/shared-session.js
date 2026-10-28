import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cycleCount, stateHash } from "../../src/lockstep.js";
import { TestMachine } from "../../src/test-machine.js";
import { Keyboard } from "../../src/web/keyboard.js";
import { SessionGuest, SessionHost } from "../../src/web/shared-session.js";
import { inProcessTransport } from "../helpers/session-link.js";
import { StockTakenFromHost, fakePage, keyCodeFor, plainCodec } from "../helpers/session-fakes.js";
import { mode7Text } from "./helpers.js";

const Model = "B-DFS1.2";
const FrameMs = 20;
const FrameCycles = 40000;
// Frames for a key to go down or up and for the OS's keyboard scan to see it, as a guest's keys are stamped a round
// trip ahead.
const KeyFrames = 5;
// Frames for a command to run and print, and for control changing hands to settle.
const SettleFrames = 50;

/** A machine with what a session needs of its page, keeping the loop's lockstep and the keyboard's input. */
async function station(transport, { boot }) {
    const machine = new TestMachine(Model);
    await machine.initialise();
    if (boot) await machine.runUntilInput();
    const keyboard = new Keyboard({
        processor: machine.processor,
        inputEnabledFunction: () => false,
        runningFunction: () => true,
    });
    const page = {
        lockstep: null,
        get input() {
            return keyboard.input;
        },
    };
    const context = {
        processor: machine.processor,
        model: machine.model,
        takenFromHost: StockTakenFromHost,
        loop: { setLockstep: (lockstep) => (page.lockstep = lockstep), replacingState: () => {} },
        keyboard,
        version: "test",
        transport,
        codec: plainCodec,
        page: fakePage(),
    };
    return { machine, context, page, keyboard };
}

async function sessionOf(guestCount) {
    const transport = inProcessTransport();
    const host = await station(transport, { boot: true });
    const guests = [];
    for (let i = 0; i < guestCount; ++i) guests.push(await station(transport, { boot: false }));
    // Once the machines are up, which needs real timers, the session's clocks run with its frames.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    host.session = new SessionHost(host.context, "room", "host");
    await host.session.start();
    for (const [i, guest] of guests.entries()) {
        guest.session = new SessionGuest(guest.context, "room", `guest${i + 1}`);
        await guest.session.start();
    }
    const everyone = [host, ...guests];
    const present = () => everyone.filter(({ page }) => page.lockstep);

    async function frames(count) {
        for (let frame = 0; frame < count; ++frame) {
            for (const { page } of present()) page.lockstep.execute(FrameCycles);
            await vi.advanceTimersByTimeAsync(FrameMs);
        }
    }

    async function type(who, text) {
        for (const char of text) {
            const key = keyCodeFor(char);
            who.page.input.keyDown(key, false);
            await frames(KeyFrames);
            who.page.input.keyUp(key);
            await frames(KeyFrames);
        }
        await frames(SettleFrames);
    }

    // As the page's paste box does.
    async function paste(who, text) {
        who.keyboard.sendRawKeyboard(who.machine.model.stringToKeys(text), true);
        while (who.keyboard.isPasting) await frames(1);
        await frames(SettleFrames);
    }

    /** Asks each machine still in the session to catch up with the others, then checks they are the same. */
    async function expectInStep(machines = present()) {
        await frames(1);
        const target = Math.max(...machines.map(({ machine }) => cycleCount(machine.processor)));
        for (const { page, machine } of machines) page.lockstep.execute(target - cycleCount(machine.processor));
        const [first, ...rest] = machines;
        for (const { machine } of rest) {
            expect(cycleCount(machine.processor)).toBe(cycleCount(first.machine.processor));
            expect(stateHash(machine.processor)).toBe(stateHash(first.machine.processor));
            expect(Buffer.compare(machine.processor.ramRomOs, first.machine.processor.ramRomOs)).toBe(0);
        }
    }

    // The session mends a machine that parts from the rest, which would hide a broken path from expectInStep: none
    // may have needed it.
    function expectNothingMended() {
        for (const { session, context } of everyone) {
            const events = session.report().events.map(({ event }) => event);
            expect(events).not.toContain("desync");
            expect(events).not.toContain("resync asked");
            expect(context.page.notices.filter((text) => /taken control back|desync/.test(text))).toEqual([]);
            expect(context.page.reloads).toEqual([]);
        }
        for (const { session } of guests) expect(session.snapshotsRestored).toBe(1);
    }

    const inControl = () =>
        everyone
            .filter(({ session, context }) => !session.left && context.page.panels.at(-1).who === "you")
            .map(({ session }) => session.name);

    await frames(SettleFrames);
    return { host, guests, frames, type, paste, expectInStep, expectNothingMended, inControl };
}

const screen = ({ machine }) => mode7Text(machine);

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("a shared session in-process", () => {
    it("brings each guest the host's machine, and what anyone types reaches every machine", async () => {
        const { host, guests, type, expectInStep, expectNothingMended } = await sessionOf(2);
        for (const guest of guests) expect(screen(guest)).toBe(screen(host));
        await type(host, "PRINT 67-25\n");
        await type(guests[1], "PRINT 99-9\n");
        for (const each of [host, ...guests]) {
            expect(screen(each)).toContain("42");
            expect(screen(each)).toContain("90");
        }
        await expectInStep();
        expectNothingMended();
    });

    it("brings what the host pastes to every guest as keys, leaving them in step", async () => {
        const { host, guests, paste, expectInStep, expectNothingMended } = await sessionOf(2);
        await paste(host, "PRINT 6*7\n");
        for (const each of [host, ...guests]) expect(screen(each)).toContain(" 42");
        await expectInStep();
        expectNothingMended();
    });

    it("brings what a guest pastes to every machine", async () => {
        const { host, guests, paste, expectInStep, expectNothingMended } = await sessionOf(2);
        await paste(guests[0], 'PRINT "PASTED";99-9\n');
        for (const each of [host, ...guests]) expect(screen(each)).toContain("PASTED90");
        await expectInStep();
        expectNothingMended();
    });

    it("lets a guest take control, everyone types, and the host takes it back", async () => {
        const { host, guests, frames, type, expectInStep, expectNothingMended, inControl } = await sessionOf(2);
        guests[0].session.requestControl();
        await frames(SettleFrames);
        expect(inControl()).toEqual(["guest1"]);
        await type(guests[0], "PRINT 50-29\n");
        await type(host, "PRINT 80-3\n");
        await type(guests[1], "PRINT 7-1\n");
        expect(inControl()).toEqual(["guest1"]);
        host.session.requestControl(null);
        await frames(SettleFrames);
        expect(inControl()).toEqual(["host"]);
        await type(guests[0], "PRINT 9-4\n");
        for (const each of [host, ...guests]) {
            for (const answer of ["21", "77", " 6", " 5"]) expect(screen(each)).toContain(answer);
        }
        await expectInStep();
        expectNothingMended();
    });

    it("passes control from guest to guest, and back to the host when the guest in control goes", async () => {
        const { host, guests, frames, type, expectInStep, expectNothingMended, inControl } = await sessionOf(2);
        guests[0].session.requestControl();
        await frames(SettleFrames);
        guests[1].session.requestControl();
        await frames(SettleFrames);
        expect(inControl()).toEqual(["guest2"]);
        await type(guests[0], "PRINT 60-18\n");
        for (const each of [host, ...guests]) expect(screen(each)).toContain("42");
        expect(inControl()).toEqual(["guest2"]);
        guests[1].session.leave("its page closed");
        await frames(SettleFrames);
        expect(inControl()).toEqual(["host"]);
        await type(host, "PRINT 70-7\n");
        expect(screen(guests[0])).toContain("63");
        await expectInStep([host, guests[0]]);
        expectNothingMended();
    });
});
