import { afterEach, describe, expect, it, vi } from "vitest";

import {
    cycleCount,
    LockstepGuest,
    LockstepHost,
    MaxCatchUpSeconds,
    MaxGuestLagSeconds,
    restoreSessionSnapshot,
    stateHash,
} from "../../src/lockstep.js";
import { RomBankBytes } from "../../src/6502.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import * as fdc from "../../src/fdc.js";
import { loadData } from "../../src/loader.js";
import { keyCodes } from "../../src/keymap.js";
import { bootedTestMachine, mode7Text } from "./helpers.js";
import { keyCodeFor } from "../helpers/session-fakes.js";
import { seededRandom } from "../helpers/seeded-random.js";

// Steps the host runs after the last input, for its effect to reach the screen.
const SettleSteps = 50;
// The MOS takes a key only once two of its 10ms polls have seen it, so a key held for less than
// about 22ms can be missed; a brisk typist's 50ms is safe however the host slices.
const KeyHoldSeconds = 0.05;
const MaxStepCycles = 60000;
const MaxDelaySteps = 12;
const EmptySliceEvery = 7;
const RtcBaseMs = Date.UTC(2026, 1, 10, 12, 0, 0);
const ScribbleAt = 0x3000;
const ScribbleBytes = 0x100;
const Scribble = 0xff;
const SidewaysRamBank = 4;
// Room for the instruction a run to a cycle finishes past it.
const InstructionSlackCycles = 100;
const MsPerMinute = 60 * 1000;

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

const press = (key) => [{ kind: "key", key, down: true }];
const release = (key) => [{ kind: "key", key, down: false }];
const tap = (key) => [...press(key), ...release(key)];
const ShiftedKeyNames = { $: "K4" };

/** The inputs that type `text` on the host. */
function typing(text) {
    return [...text].flatMap((char) => {
        if (ShiftedKeyNames[char]) {
            const shift = keyCodes.SHIFT_LEFT;
            return [...press(shift), ...tap(keyCodes[ShiftedKeyNames[char]]), ...release(shift)];
        }
        const key = keyCodeFor(char);
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
 * with `inputs` fed in at most one per step, a null taking a step and a key waiting
 * until the host has run KeyHoldSeconds since the key before it; commits reach each
 * guest after a random delay, in order; and each guest runs uneven slices of its own.
 * Just before the input with that index goes in, `joinAt` adds a guest, `corruptAt`
 * scribbles on the first guest's RAM, `resetAt` hard resets the host and
 * `guestResetAt` the first guest. A guest that desyncs, and every guest after the host
 * jumps, is sent a fresh snapshot down the same queue, as a browser's host would.
 * `prepare` may change the host before the session starts.
 */
async function runSession({ model, inputs, joinAt = [0], corruptAt, resetAt, guestResetAt, prepare, seed = 1 }) {
    const fraction = seededRandom(seed);
    const random = (limit) => Math.floor(fraction() * limit);
    const host = await bootedTestMachine(model);
    prepare?.(host);
    const guests = [];
    let step = 0;
    let jumps = 0;
    const hashedAt = [];
    let corruptedAt;
    let guestResetFrom;
    const queue = (guest, message) => guest.inbox.push({ due: step + random(MaxDelaySteps), message });
    const resync = (guest) => queue(guest, { snapshot: wireSnapshot(lockstep) });
    const lockstep = hosting(
        host,
        (commit) => {
            if (commit.hash !== undefined) hashedAt.push(commit.upTo);
            for (const guest of guests) queue(guest, { commit: JSON.stringify(commit) });
        },
        () => {
            jumps++;
            guests.forEach(resync);
        },
    );
    const keyHoldCycles = KeyHoldSeconds * host.model.cyclesPerSecond;
    let fed = 0;
    let lastKeyAt = -Infinity;
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
    for (let settling = SettleSteps; fed < inputs.length || settling > 0; ++step) {
        if (fed === inputs.length) --settling;
        const input = inputs[fed];
        const due = fed < inputs.length && (!input || cycleCount(host.processor) - lastKeyAt >= keyHoldCycles);
        if (due) {
            if (joinAt.includes(fed)) {
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
            if (fed === corruptAt) {
                corruptedAt = cycleCount(guests[0].machine.processor);
                for (let offset = 0; offset < ScribbleBytes; ++offset) {
                    guests[0].machine.processor.writemem(ScribbleAt + offset, Scribble);
                }
            }
            if (fed === resetAt) host.processor.reset(true);
            if (fed === guestResetAt) {
                guestResetFrom = cycleCount(guests[0].machine.processor);
                guests[0].machine.processor.reset(true);
            }
            if (input) {
                lockstep.input(keyInput(host, input.key, input.down));
                lastKeyAt = cycleCount(host.processor);
            }
            ++fed;
        }
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
    return {
        host,
        guests,
        jumps,
        desyncs: guests.flatMap((guest) => guest.desyncs),
        hashedAt,
        corruptedAt,
        guestResetFrom,
    };
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
        // Just before the sixth key comes up.
        const joinWithKeyHeld = 11;
        const { host, guests, desyncs } = await runSession({
            model: "B-DFS1.2",
            inputs: typing("PRINT 67-25\n"),
            joinAt: [0, joinWithKeyHeld],
        });
        expect(desyncs).toEqual([]);
        expect(mode7Text(host)).toContain("42");
        expectIdentical(host, guests);
    });

    it("hands a joiner the host's sideways RAM, settings and clock, read the same in any time zone", async () => {
        const sidewaysByte = 0x5a;
        const settingAddress = 0x30;
        const setting = 0x77;
        // 12:00 on the base, so TIME$ reads 13:3x.
        const clockOffsetMs = 90 * MsPerMinute;
        const { host, guests, desyncs } = await runSession({
            model: "Master",
            inputs: typing("PRINT TIME$\n"),
            seed: 7,
            prepare: ({ processor }) => {
                processor.ramRomOs[processor.romOffset + SidewaysRamBank * RomBankBytes] = sidewaysByte;
                processor.sysvia.cmos.store[settingAddress] = setting;
                processor.sysvia.cmos.timeOffset = clockOffsetMs;
            },
        });
        expect(desyncs).toEqual([]);
        expect(mode7Text(host)).toMatch(/Feb 2026\.13:3/);
        expectIdentical(host, guests);
    });

    it("brings back a guest that drifted, every guest after the host is reset, and a guest that reset itself", async () => {
        const afterReset = 300;
        const { host, guests, jumps, desyncs, hashedAt, corruptedAt, guestResetFrom } = await runSession({
            model: "B-DFS1.2",
            inputs: [...Array(afterReset).fill(null), ...typing("PRINT 67-25\n")],
            joinAt: [0, 20],
            corruptAt: 30,
            resetAt: 100,
            guestResetAt: 160,
            seed: 3,
        });
        expect(jumps).toBe(1);
        // Each is put right by the one resync it asks for, and the host's reset needs none.
        const firstHashAfterCorruption = hashedAt.find((upTo) => upTo > corruptedAt);
        expect(desyncs).toEqual([
            `state differs at cycle ${firstHashAfterCorruption}`,
            `its machine moved from ${guestResetFrom} by itself`,
        ]);
        expect(mode7Text(host)).toContain("42");
        expectIdentical(host, guests);
    });

    describe("one host and one guest", () => {
        async function pair({ prepareHost = async () => {}, prepareGuest } = {}) {
            const host = await bootedTestMachine("B-DFS1.2");
            await prepareHost(host);
            const commits = [];
            const lockstep = hosting(host, (commit) => commits.push(commit));
            const desyncs = [];
            const guest = await joining(lockstep, host.model.name, (...desync) => desyncs.push(desync), prepareGuest);
            return { host, lockstep, guest, commits, desyncs };
        }

        it("gives the guest the host's discs, even in a drive it had empty, never writing to its own", async () => {
            const image = "discs/elite.ssd";
            const data = await loadData(image);
            const guestDisc = fdc.discFor(image, data, () => {});
            const { host, guest } = await pair({
                prepareHost: ({ processor }) => processor.fdc.loadDisc(1, fdc.discFor(image, data)),
                prepareGuest: ({ processor }) => processor.fdc.loadDisc(0, guestDisc),
            });
            const [emptied, shared] = guest.machine.processor.fdc.drives;
            expect(guestDisc.savesChanges).toBe(true);
            expect(emptied.disc).toBeUndefined();
            expect(shared.disc.savesChanges).toBe(false);
            const firstTrack = (drive) => drive.disc.getTrack(false, 0).pulses2Us;
            expect(firstTrack(shared)).toEqual(firstTrack(host.processor.fdc.drives[1]));
        });

        it("hands over the VIAs as they are, whatever keys the joiner was holding, and a held BREAK", async () => {
            const { host, lockstep, guest } = await pair({
                prepareGuest: ({ processor }) => processor.sysvia.keyDown(keyCodes.A, false),
            });
            const devices = ({ processor }) => [processor.sysvia.snapshotState(), processor.uservia.snapshotState()];
            expect(devices(guest.machine)).toEqual(devices(host));
            lockstep.input({ kind: "break", down: true });
            lockstep.execute(1000);
            const late = await joining(lockstep, host.model.name);
            expect(late.machine.processor.resetLine).toBe(host.processor.resetLine);
            expect(host.processor.resetLine).toBe(false);
        });

        it("hashes the machine once each emulated second", async () => {
            const { host, lockstep, commits } = await pair();
            const seconds = 3;
            const slicesPerSecond = 10;
            const second = host.model.cyclesPerSecond;
            const slice = second / slicesPerSecond;
            const start = cycleCount(host.processor);
            // One slice spare: each hash is due a second after the commit that took the last one ended.
            for (let i = 0; i < seconds * slicesPerSecond + 1; ++i) lockstep.execute(slice);
            const hashedAt = commits.filter((commit) => commit.hash !== undefined).map((commit) => commit.upTo);
            expect(hashedAt).toHaveLength(seconds);
            const gaps = hashedAt.map((upTo, i) => upTo - (i === 0 ? start : hashedAt[i - 1]));
            for (const gap of gaps) {
                expect(gap).toBeGreaterThanOrEqual(second);
                expect(gap).toBeLessThanOrEqual(second + slice + InstructionSlackCycles);
            }
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

        it("asks for a resync, once, when commits go missing, naming the commit that did not follow on", async () => {
            const { lockstep, guest, commits, desyncs } = await pair();
            for (let i = 0; i < 4; ++i) lockstep.execute(1000);
            guest.lockstep.receive(commits[0]);
            guest.lockstep.receive(commits[2]);
            guest.lockstep.receive(commits[3]);
            const { at, upTo } = commits[2];
            expect(desyncs.map(([reason, , , where]) => [reason, where])).toEqual([
                [`a commit starts at ${at}, not ${commits[0].upTo}`, { cycle: commits[0].at, at, upTo }],
            ]);
        });

        it("says from which cycle its machine moved by itself", async () => {
            const { guest, desyncs } = await pair();
            const from = cycleCount(guest.machine.processor);
            guest.machine.processor.execute(1000);
            const cycle = cycleCount(guest.machine.processor);
            guest.lockstep.execute(1000);
            expect(desyncs).toEqual([[`its machine moved from ${from} by itself`, [], true, { cycle, from }]]);
        });

        it("says where its state parted from the host's, in which commit, and both hashes", async () => {
            const { host, lockstep, guest, commits, desyncs } = await pair();
            for (let offset = 0; offset < ScribbleBytes; ++offset) {
                guest.machine.processor.writemem(ScribbleAt + offset, Scribble);
            }
            lockstep.execute(host.model.cyclesPerSecond);
            const [commit] = commits;
            guest.lockstep.receive(commit);
            guest.lockstep.execute(commit.upTo - commit.at);
            const { at, upTo, hash } = commit;
            expect(desyncs).toEqual([
                [
                    `state differs at cycle ${upTo}`,
                    [],
                    false,
                    { cycle: upTo, at, upTo, expectedHash: hash, hash: stateHash(guest.machine.processor) },
                ],
            ]);
        });

        it("catches up a slice at a time when far behind, and runs no faster than asked when close", async () => {
            const { host, lockstep, guest, commits } = await pair();
            const { cyclesPerSecond } = host.model;
            for (let i = 0; i < 10; ++i) lockstep.execute(cyclesPerSecond / 10);
            commits.forEach((commit) => guest.lockstep.receive(commit));
            const asked = 1000;
            const ran = () => {
                const before = cycleCount(guest.machine.processor);
                guest.lockstep.execute(asked);
                return cycleCount(guest.machine.processor) - before;
            };
            expect(ran()).toBeGreaterThanOrEqual(MaxCatchUpSeconds * cyclesPerSecond);
            expect(ran()).toBeLessThan(MaxCatchUpSeconds * cyclesPerSecond + InstructionSlackCycles);
            while (guest.lockstep.behind() > MaxGuestLagSeconds * cyclesPerSecond) ran();
            expect(ran()).toBeLessThan(asked + InstructionSlackCycles);
        });
    });

    describe("the session clock", () => {
        afterEach(() => {
            vi.useRealTimers();
            vi.unstubAllEnvs();
        });

        it("shows the host's wall time, and starts again from it after the host jumps", async () => {
            vi.stubEnv("TZ", "America/New_York");
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Date.UTC(2026, 1, 10, 17, 0, 30));
            const host = await bootedTestMachine("Master");
            const { cyclesPerSecond } = host.model;
            // Time on the clock before the session, which a jump must not take off it.
            host.processor.execute(3 * cyclesPerSecond);
            const lockstep = new LockstepHost(
                host.processor,
                () => {},
                () => {},
            );
            const clock = () => {
                const time = host.processor.sysvia.cmos.bbcDateTime();
                return [time.getHours(), time.getMinutes(), time.getSeconds()];
            };
            expect(clock()).toEqual([12, 0, 30]);
            lockstep.execute(5 * cyclesPerSecond);
            expect(clock()).toEqual([12, 0, 35]);
            host.processor.reset(true);
            lockstep.execute(0);
            expect(clock()).toEqual([12, 0, 30]);
        });
    });
});
