import { describe, expect, it } from "vitest";

import {
    cycleCount,
    isValidCommit,
    isValidInput,
    LockstepGuest,
    LockstepHost,
    MaxCatchUpSeconds,
    MaxGuestLagSeconds,
    restoreSessionSnapshot,
    stateHash,
} from "../../src/lockstep.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import * as fdc from "../../src/fdc.js";
import { keyCodes } from "../../src/keymap.js";
import { mode7Text } from "./helpers.js";

const HostSteps = 1500;
const MaxStepCycles = 60000;
const MaxDelaySteps = 12;
const EmptySliceEvery = 7;
const RtcBaseMs = Date.UTC(2026, 1, 10, 12, 0, 0);
const ScribbleAt = 0x3000;
const ScribbleBytes = 0x100;
const Scribble = 0xff;
const SidewaysRamBank = 4;
const RomBankBytes = 16384;

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

const hosting = (machine, send = () => {}, onJump = () => {}) =>
    new LockstepHost(machine.processor, send, onJump, { rtcBaseMs: RtcBaseMs });

// Through the same serialisation the network uses.
const wireSnapshot = (lockstep) => snapshotToJSON(lockstep.snapshot());

async function joining(lockstep, model, onDesync = () => {}, prepare = async () => {}) {
    const machine = new TestMachine(model);
    await machine.initialise();
    await prepare(machine);
    restoreSessionSnapshot(machine.processor, snapshotFromJSON(wireSnapshot(lockstep)));
    return { machine, lockstep: new LockstepGuest(machine.processor, onDesync) };
}

const Gap = [null, null, null];

// One input per host step; the gaps let the OS's keyboard scan see each change.
const press = (key) => [{ kind: "key", key, down: true }, ...Gap];
const release = (key) => [{ kind: "key", key, down: false }, ...Gap];
const tap = (key) => [...press(key), ...release(key)];
const KeyNames = { " ": "SPACE", "-": "MINUS", "\n": "ENTER" };
const ShiftedKeyNames = { $: "K4" };

/** The inputs that type `text` on the host, one per step. */
function typing(text) {
    return [...text].flatMap((char) => {
        if (ShiftedKeyNames[char]) {
            const shift = keyCodes.SHIFT_LEFT;
            return [...press(shift), ...tap(keyCodes[ShiftedKeyNames[char]]), ...release(shift)];
        }
        const key = keyCodes[KeyNames[char] ?? (/\d/.test(char) ? `K${char}` : char)];
        if (!key) throw new Error(`typing() has no key for "${char}"`);
        return tap(key);
    });
}

const keyInput = (machine, key, down) => ({
    kind: "key",
    mapping: machine.processor.sysvia.keyMapping(key, false),
    down,
});

/**
 * Runs a session in-process: the host executes uneven slices, some of them empty,
 * with `inputs` fed in one per step; commits reach each guest after a random delay,
 * in order; and each guest runs uneven slices of its own. `joinAt` adds a guest at
 * that host step, `corruptAt` scribbles on the first guest's RAM, `resetAt` hard
 * resets the host and `guestResetAt` the first guest. A guest that desyncs, and every
 * guest after the host jumps, is sent a fresh snapshot down the same queue, as a
 * browser's host would. `prepare` may change the host before the session starts.
 */
async function runSession({ model, inputs, joinAt = [0], corruptAt, resetAt, guestResetAt, prepare, seed = 1 }) {
    const random = seededRandom(seed);
    const host = await booted(model);
    prepare?.(host);
    const guests = [];
    let step = 0;
    let jumps = 0;
    const queue = (guest, message) => guest.inbox.push({ due: step + random(MaxDelaySteps), message });
    const resync = (guest) => queue(guest, { snapshot: wireSnapshot(lockstep) });
    const lockstep = hosting(
        host,
        (commit) => {
            for (const guest of guests) queue(guest, { commit: JSON.stringify(commit) });
        },
        () => {
            jumps++;
            guests.forEach(resync);
        },
    );
    const typed = inputs.map((input) => input && keyInput(host, input.key, input.down));
    const deliver = (guest, now) => {
        while (guest.inbox.length > 0 && guest.inbox[0].due <= now) {
            const { commit, snapshot } = guest.inbox.shift().message;
            if (snapshot) {
                restoreSessionSnapshot(guest.machine.processor, snapshotFromJSON(snapshot));
                guest.lockstep.resync();
            } else {
                guest.lockstep.receive(JSON.parse(commit));
            }
        }
    };
    for (; step < HostSteps; ++step) {
        if (joinAt.includes(step)) {
            const guest = { inbox: [], desyncs: [] };
            Object.assign(
                guest,
                await joining(lockstep, model, (reason) => {
                    guest.desyncs.push(reason);
                    resync(guest);
                }),
            );
            guests.push(guest);
        }
        if (step === corruptAt) {
            for (let offset = 0; offset < ScribbleBytes; ++offset) {
                guests[0].machine.processor.writemem(ScribbleAt + offset, Scribble);
            }
        }
        if (step === resetAt) host.processor.reset(true);
        if (step === guestResetAt) guests[0].machine.processor.reset(true);
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
    const { processor } = host;
    for (const { machine } of guests) {
        expect(cycleCount(machine.processor)).toBe(cycleCount(processor));
        expect(stateHash(machine.processor)).toBe(stateHash(processor));
        expect(machine.processor.ramRomOs).toEqual(processor.ramRomOs);
        expect(machine.processor.sysvia.cmos.store).toEqual(processor.sysvia.cmos.store);
        expect(mode7Text(machine)).toBe(mode7Text(host));
    }
}

describe("lockstep sessions", () => {
    it("keeps guests identical to the host while it types, through delays and uneven slices", async () => {
        // The second guest joins with a key held down.
        const { host, guests, desyncs } = await runSession({
            model: "B-DFS1.2",
            inputs: typing("PRINT 67-25\n"),
            joinAt: [0, 41],
        });
        expect(desyncs).toEqual([]);
        expect(mode7Text(host)).toContain("42");
        expectIdentical(host, guests);
    });

    it("hands a joiner the host's sideways RAM, settings and clock, read the same in any time zone", async () => {
        const { host, guests, desyncs } = await runSession({
            model: "Master",
            inputs: typing("PRINT TIME$\n"),
            seed: 7,
            prepare: ({ processor }) => {
                processor.ramRomOs[processor.romOffset + SidewaysRamBank * RomBankBytes] = 0x5a;
                processor.sysvia.cmos.store[0x30] = 0x77;
                processor.sysvia.cmos.timeOffset = 90 * 60 * 1000;
            },
        });
        expect(desyncs).toEqual([]);
        expect(mode7Text(host)).toMatch(/Feb 2026\.13:3/);
        expectIdentical(host, guests);
    });

    it("brings back a guest that drifted, every guest after the host is reset, and a guest that reset itself", async () => {
        const afterReset = 900;
        const { host, guests, jumps, desyncs } = await runSession({
            model: "B-DFS1.2",
            inputs: [...Array(afterReset).fill(null), ...typing("PRINT 67-25\n")],
            joinAt: [0, 20],
            corruptAt: 100,
            resetAt: 400,
            guestResetAt: 550,
            seed: 3,
        });
        expect(jumps).toBe(1);
        expect(desyncs.some((reason) => /differs from the host's/.test(reason))).toBe(true);
        expect(desyncs.some((reason) => /moved from \d+ by itself/.test(reason))).toBe(true);
        expect(mode7Text(host)).toContain("42");
        expectIdentical(host, guests);
    });

    describe("one host and one guest", () => {
        async function pair({ prepareHost = async () => {}, prepareGuest } = {}) {
            const host = await booted("B-DFS1.2");
            await prepareHost(host);
            const commits = [];
            const lockstep = hosting(host, (commit) => commits.push(commit));
            const desyncs = [];
            const guest = await joining(lockstep, host.model.name, (reason) => desyncs.push(reason), prepareGuest);
            return { host, lockstep, guest, commits, desyncs };
        }

        it("gives the guest the host's discs, never writing to its own", async () => {
            const image = "discs/elite.ssd";
            const data = await fdc.load(image);
            let guestDisc;
            const { host, guest } = await pair({
                prepareHost: ({ processor }) => processor.fdc.loadDisc(1, fdc.discFor(image, data)),
                prepareGuest: ({ processor }) => {
                    guestDisc = fdc.discFor(image, data, () => {});
                    processor.fdc.loadDisc(0, guestDisc);
                },
            });
            const [ownDrive, sharedDrive] = guest.machine.processor.fdc.drives;
            expect(guestDisc.savesChanges).toBe(true);
            expect(ownDrive.disc).toBeUndefined();
            expect(sharedDrive.disc).not.toBe(guestDisc);
            expect(sharedDrive.disc.savesChanges).toBe(false);
            const firstTrack = (drive) => drive.disc.getTrack(false, 0).pulses2Us;
            expect(firstTrack(sharedDrive)).toEqual(firstTrack(host.processor.fdc.drives[1]));
        });

        it("keeps a commit that ran no cycles, and its inputs", async () => {
            const { host, lockstep, guest, commits, desyncs } = await pair();
            lockstep.input(keyInput(host, keyCodes.A, true));
            lockstep.execute(0);
            lockstep.execute(1000);
            commits.forEach((commit) => guest.lockstep.receive(commit));
            guest.lockstep.execute(1000);
            expect(desyncs).toEqual([]);
            expect(guest.machine.processor.sysvia.hasAnyKeyDown()).toBe(true);
        });

        it("asks for a resync, once, when commits go missing", async () => {
            const { lockstep, guest, commits, desyncs } = await pair();
            for (let i = 0; i < 4; ++i) lockstep.execute(1000);
            guest.lockstep.receive(commits[0]);
            guest.lockstep.receive(commits[2]);
            guest.lockstep.receive(commits[3]);
            expect(desyncs).toHaveLength(1);
            expect(desyncs[0]).toMatch(/starts at \d+, not \d+/);
        });

        it("catches up a slice at a time when far behind, and runs no faster than asked when close", async () => {
            const { host, lockstep, guest, commits } = await pair();
            const { cyclesPerSecond } = host.model;
            for (let i = 0; i < 10; ++i) lockstep.execute(cyclesPerSecond / 10);
            commits.forEach((commit) => guest.lockstep.receive(commit));
            const ran = () => {
                const before = cycleCount(guest.machine.processor);
                guest.lockstep.execute(1000);
                return cycleCount(guest.machine.processor) - before;
            };
            expect(ran()).toBeGreaterThanOrEqual(MaxCatchUpSeconds * cyclesPerSecond);
            expect(ran()).toBeLessThan(MaxCatchUpSeconds * cyclesPerSecond + 100);
            while (guest.lockstep.behind() > MaxGuestLagSeconds * cyclesPerSecond) ran();
            expect(ran()).toBeLessThan(1100);
        });
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
