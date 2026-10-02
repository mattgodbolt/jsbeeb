import { describe, expect, it } from "vitest";

import { cycleCount, isValidInput, LockstepGuest, LockstepHost, stateHash } from "../../src/lockstep.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import { keyCodes } from "../../src/keymap.js";
import { mode7Text } from "./helpers.js";

const HostSteps = 1500;
const MaxStepCycles = 60000;
const MaxDelaySteps = 12;

function seededRandom(seed) {
    let state = seed;
    return (limit) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % limit;
    };
}

async function booted(model) {
    const machine = new TestMachine(model);
    await machine.initialise();
    await machine.runUntilInput();
    return machine;
}

function sessionClock(cpu, baseMs) {
    return () => baseMs + (cycleCount(cpu) * 1000) / cpu.model.cyclesPerSecond;
}

// What a joiner is sent, through the same serialisation the network uses.
function joinSnapshot(host) {
    return snapshotToJSON({
        state: host.processor.snapshotState({ includeRoms: true }),
        at: cycleCount(host.processor),
    });
}

async function join(host, json, rtcBaseMs) {
    const guest = new TestMachine(host.model.name);
    await guest.initialise();
    const { state, at } = snapshotFromJSON(json);
    guest.processor.restoreState(state);
    expect(cycleCount(guest.processor)).toBe(at);
    if (rtcBaseMs !== undefined) {
        guest.processor.sysvia.cmos.joinSession(
            host.processor.sysvia.cmos.store,
            sessionClock(guest.processor, rtcBaseMs),
        );
    }
    return guest;
}

const Gap = [null, null, null];

// One input per host step; the gaps let the OS's keyboard scan see each change.
const press = (key) => [{ kind: "key", key, down: true }, ...Gap];
const release = (key) => [{ kind: "key", key, down: false }, ...Gap];
const tap = (key) => [...press(key), ...release(key)];
const taps = (keys) => keys.flatMap(tap);

function mapped(machine, inputs) {
    return inputs.map(
        (input) =>
            input && { kind: "key", mapping: machine.processor.sysvia.keyMapping(input.key, false), down: input.down },
    );
}

/**
 * Runs a session in-process: the host executes uneven slices with `inputs` fed
 * in one per step, commits reach each guest after a random delay, and each guest
 * runs uneven slices of its own. `joinAt` adds a guest at that host step.
 */
async function runSession({ model, inputs, joinAt = [0], rtcBaseMs, seed = 1 }) {
    const random = seededRandom(seed);
    const host = await booted(model);
    if (rtcBaseMs !== undefined) {
        const cmos = host.processor.sysvia.cmos;
        cmos.joinSession(cmos.store, sessionClock(host.processor, rtcBaseMs));
    }
    const guests = [];
    const desyncs = [];
    const lockstep = new LockstepHost(host.processor, (commit) => {
        const json = JSON.stringify(commit);
        for (const guest of guests) guest.inbox.push({ due: step + random(MaxDelaySteps), json });
    });
    const typed = mapped(host, inputs);
    let step = 0;
    const deliver = (guest, now) => {
        while (guest.inbox.length > 0 && guest.inbox[0].due <= now)
            guest.lockstep.receive(JSON.parse(guest.inbox.shift().json));
    };
    for (; step < HostSteps; ++step) {
        if (joinAt.includes(step)) {
            const machine = await join(host, joinSnapshot(host), rtcBaseMs);
            const guest = { machine, inbox: [] };
            guest.lockstep = new LockstepGuest(machine.processor, (reason) => desyncs.push(reason));
            guests.push(guest);
        }
        const input = typed[step];
        if (input) lockstep.input(input);
        lockstep.execute(1 + random(MaxStepCycles));
        for (const guest of guests) {
            deliver(guest, step);
            guest.lockstep.execute(1 + random(MaxStepCycles));
        }
    }
    for (const guest of guests) {
        deliver(guest, Infinity);
        while (guest.lockstep.behind() > 0) guest.lockstep.execute(MaxStepCycles);
    }
    return { host, guests, desyncs };
}

describe("lockstep sessions", () => {
    it("keeps guests identical to the host while it types, through delays and uneven slices", async () => {
        const { P, R, I, N, T, SPACE, K6, K7, MINUS, K2, K5, ENTER } = keyCodes;
        const keys = taps([P, R, I, N, T, SPACE, K6, K7, MINUS, K2, K5, ENTER]);
        const { host, guests, desyncs } = await runSession({ model: "B-DFS1.2", inputs: keys, joinAt: [0, 40] });
        expect(desyncs).toEqual([]);
        expect(mode7Text(host)).toContain("42");
        for (const { machine } of guests) {
            expect(cycleCount(machine.processor)).toBe(cycleCount(host.processor));
            expect(stateHash(machine.processor)).toBe(stateHash(host.processor));
            expect(mode7Text(machine)).toBe(mode7Text(host));
        }
    });

    it("gives every Master in a session the same clock", async () => {
        const { P, R, I, N, T, SPACE, M, E, K4, SHIFT_LEFT, ENTER } = keyCodes;
        const keys = [
            ...taps([P, R, I, N, T, SPACE, T, I, M, E]),
            ...press(SHIFT_LEFT),
            ...tap(K4),
            ...release(SHIFT_LEFT),
            ...tap(ENTER),
        ];
        const rtcBaseMs = Date.UTC(2026, 1, 10, 12, 0, 0);
        const { host, guests, desyncs } = await runSession({ model: "Master", inputs: keys, rtcBaseMs, seed: 7 });
        expect(desyncs).toEqual([]);
        expect(mode7Text(host)).toMatch(/Feb 2026/);
        for (const { machine } of guests) {
            expect(stateHash(machine.processor)).toBe(stateHash(host.processor));
            expect(mode7Text(machine)).toBe(mode7Text(host));
        }
    });

    it("reports a guest that has drifted from the host", async () => {
        const host = await booted("B-DFS1.2");
        const guestMachine = await join(host, joinSnapshot(host));
        const desyncs = [];
        const guest = new LockstepGuest(guestMachine.processor, (reason) => desyncs.push(reason));
        const lockstep = new LockstepHost(host.processor, (commit) => guest.receive(commit));
        guestMachine.processor.writemem(0x3000, 0x55);
        for (let i = 0; i < 100 && desyncs.length === 0; ++i) {
            lockstep.execute(50000);
            guest.execute(50000);
        }
        expect(desyncs).toHaveLength(1);
        expect(desyncs[0]).toMatch(/differs from the host's/);
    });

    it("accepts only well-formed inputs from a guest", () => {
        expect(isValidInput({ kind: "key", mapping: [4, 1], down: true })).toBe(true);
        expect(isValidInput({ kind: "key", mapping: [4, 1, false], down: false })).toBe(true);
        expect(isValidInput({ kind: "break", down: true })).toBe(true);
        expect(isValidInput({ kind: "key", mapping: [16, 1], down: true })).toBe(false);
        expect(isValidInput({ kind: "key", mapping: [4, 1], down: 1 })).toBe(false);
        expect(isValidInput({ kind: "key", mapping: "x", down: true })).toBe(false);
        expect(isValidInput({ kind: "poke", address: 0 })).toBe(false);
        expect(isValidInput(null)).toBe(false);
    });
});
