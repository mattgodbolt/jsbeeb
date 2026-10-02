import { describe, expect, it } from "vitest";

import { cycleCount, isValidCommit, isValidInput, LockstepGuest, LockstepHost, stateHash } from "../../src/lockstep.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import { keyCodes } from "../../src/keymap.js";
import { mode7Text } from "./helpers.js";

const HostSteps = 1500;
const MaxStepCycles = 60000;
const MaxDelaySteps = 12;
const EmptySliceEvery = 7;

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
        keyboard: host.processor.sysvia.keyboardState(),
        at: cycleCount(host.processor),
    });
}

function restoreInto(machine, json, rtcBaseMs, store) {
    const { state, keyboard, at } = snapshotFromJSON(json);
    machine.processor.restoreState(state);
    machine.processor.sysvia.restoreKeyboard(keyboard);
    expect(cycleCount(machine.processor)).toBe(at);
    if (rtcBaseMs !== undefined) {
        machine.processor.sysvia.cmos.joinSession(store, sessionClock(machine.processor, rtcBaseMs));
    }
}

async function join(host, json, rtcBaseMs) {
    const guest = new TestMachine(host.model.name);
    await guest.initialise();
    restoreInto(guest, json, rtcBaseMs, host.processor.sysvia.cmos.store);
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
 * Runs a session in-process: the host executes uneven slices, some of them empty,
 * with `inputs` fed in one per step; commits reach each guest after a random delay,
 * in order; and each guest runs uneven slices of its own. `joinAt` adds a guest at
 * that host step, `corruptAt` scribbles on the first guest's RAM and `resetAt` hard
 * resets the host. A guest that desyncs, and every guest after the host jumps, is
 * sent a fresh snapshot down the same queue, as the browser's session does.
 */
async function runSession({ model, inputs, joinAt = [0], corruptAt, resetAt, rtcBaseMs, seed = 1 }) {
    const random = seededRandom(seed);
    const host = await booted(model);
    const { cmos } = host.processor.sysvia;
    if (rtcBaseMs !== undefined) cmos.joinSession(cmos.store, sessionClock(host.processor, rtcBaseMs));
    const guests = [];
    let step = 0;
    let jumps = 0;
    const queue = (guest, message) => guest.inbox.push({ due: step + random(MaxDelaySteps), message });
    const resync = (guest) => queue(guest, { snapshot: joinSnapshot(host) });
    const lockstep = new LockstepHost(
        host.processor,
        (commit) => {
            for (const guest of guests) queue(guest, { commit: JSON.stringify(commit) });
        },
        () => {
            jumps++;
            guests.forEach(resync);
        },
    );
    const typed = mapped(host, inputs);
    const deliver = (guest, now) => {
        while (guest.inbox.length > 0 && guest.inbox[0].due <= now) {
            const { commit, snapshot } = guest.inbox.shift().message;
            if (snapshot) {
                restoreInto(guest.machine, snapshot, rtcBaseMs, cmos.store);
                guest.lockstep.resync();
                guest.awaitingResync = false;
            } else {
                guest.lockstep.receive(JSON.parse(commit));
            }
        }
    };
    for (; step < HostSteps; ++step) {
        if (joinAt.includes(step)) {
            const machine = await join(host, joinSnapshot(host), rtcBaseMs);
            const guest = { machine, inbox: [], desyncs: [] };
            // As the browser's guest, which asks once and waits.
            guest.lockstep = new LockstepGuest(machine.processor, (reason) => {
                guest.desyncs.push(reason);
                if (guest.awaitingResync) return;
                guest.awaitingResync = true;
                resync(guest);
            });
            guests.push(guest);
        }
        if (step === corruptAt) {
            for (let address = 0x3000; address < 0x3100; ++address) guests[0].machine.processor.writemem(address, 0xff);
        }
        if (step === resetAt) host.processor.reset(true);
        const input = typed[step];
        if (input) lockstep.input(input);
        lockstep.execute(step % EmptySliceEvery === 0 ? 0 : random(MaxStepCycles));
        for (const guest of guests) {
            deliver(guest, step);
            guest.lockstep.execute(random(MaxStepCycles));
        }
    }
    for (const guest of guests) {
        deliver(guest, Infinity);
        while (guest.lockstep.behind() > 0) guest.lockstep.execute(MaxStepCycles);
    }
    return { host, guests, jumps, desyncs: guests.flatMap((guest) => guest.desyncs) };
}

function expectIdentical(host, guests) {
    for (const { machine } of guests) {
        expect(cycleCount(machine.processor)).toBe(cycleCount(host.processor));
        expect(stateHash(machine.processor)).toBe(stateHash(host.processor));
        expect(mode7Text(machine)).toBe(mode7Text(host));
    }
}

describe("lockstep sessions", () => {
    it("keeps guests identical to the host while it types, through delays and uneven slices", async () => {
        const { P, R, I, N, T, SPACE, K6, K7, MINUS, K2, K5, ENTER } = keyCodes;
        const keys = taps([P, R, I, N, T, SPACE, K6, K7, MINUS, K2, K5, ENTER]);
        const { host, guests, desyncs } = await runSession({ model: "B-DFS1.2", inputs: keys, joinAt: [0, 40] });
        expect(desyncs).toEqual([]);
        expect(mode7Text(host)).toContain("42");
        expectIdentical(host, guests);
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
        expectIdentical(host, guests);
    });

    it("brings back a guest that drifted, and every guest after the host is hard reset", async () => {
        const { P, R, I, N, T, SPACE, K6, K7, MINUS, K2, K5, ENTER } = keyCodes;
        const afterReset = 700;
        const keys = [...Array(afterReset).fill(null), ...taps([P, R, I, N, T, SPACE, K6, K7, MINUS, K2, K5, ENTER])];
        const { host, guests, jumps, desyncs } = await runSession({
            model: "B-DFS1.2",
            inputs: keys,
            joinAt: [0, 20],
            corruptAt: 100,
            resetAt: 400,
            seed: 3,
        });
        expect(jumps).toBe(1);
        expect(desyncs.some((reason) => /differs from the host's/.test(reason))).toBe(true);
        expect(mode7Text(host)).toContain("42");
        expectIdentical(host, guests);
    });

    it("keeps a commit that ran no cycles, and its inputs", async () => {
        const host = await booted("B-DFS1.2");
        const guestMachine = await join(host, joinSnapshot(host));
        const desyncs = [];
        const guest = new LockstepGuest(guestMachine.processor, (reason) => desyncs.push(reason));
        const lockstep = new LockstepHost(host.processor, (commit) => guest.receive(commit));
        lockstep.input({ kind: "key", mapping: host.processor.sysvia.keyMapping(keyCodes.A, false), down: true });
        lockstep.execute(0);
        lockstep.execute(1000);
        guest.execute(1000);
        expect(desyncs).toEqual([]);
        expect(guestMachine.processor.sysvia.hasAnyKeyDown()).toBe(true);
    });

    it("asks for a resync when commits go missing", async () => {
        const host = await booted("B-DFS1.2");
        const guestMachine = await join(host, joinSnapshot(host));
        const desyncs = [];
        const guest = new LockstepGuest(guestMachine.processor, (reason) => desyncs.push(reason));
        const commits = [];
        const lockstep = new LockstepHost(host.processor, (commit) => commits.push(commit));
        for (let i = 0; i < 3; ++i) lockstep.execute(1000);
        guest.receive(commits[0]);
        guest.receive(commits[2]);
        expect(desyncs).toHaveLength(1);
        expect(desyncs[0]).toMatch(/starts at \d+, not \d+/);
    });

    it("accepts only well-formed inputs and commits from a peer", () => {
        expect(isValidInput({ kind: "key", mapping: [4, 1], down: true })).toBe(true);
        expect(isValidInput({ kind: "key", mapping: [4, 1, false], down: false })).toBe(true);
        expect(isValidInput({ kind: "break", down: true })).toBe(true);
        expect(isValidInput({ kind: "key", mapping: [16, 1], down: true })).toBe(false);
        expect(isValidInput({ kind: "key", mapping: [4, 1], down: 1 })).toBe(false);
        expect(isValidInput({ kind: "key", mapping: "x", down: true })).toBe(false);
        expect(isValidInput({ kind: "poke", address: 0 })).toBe(false);
        expect(isValidInput(null)).toBe(false);
        expect(isValidCommit({ at: 5, upTo: 9, inputs: [{ kind: "break", down: false }] })).toBe(true);
        expect(isValidCommit({ at: 5, upTo: 9, inputs: [], hash: "1a" })).toBe(true);
        expect(isValidCommit({ at: 5, upTo: 4, inputs: [] })).toBe(false);
        expect(isValidCommit({ at: 5, upTo: 9 })).toBe(false);
        expect(isValidCommit({ at: 5, upTo: 9, inputs: [{ kind: "poke" }] })).toBe(false);
    });
});
