import { describe, expect, it } from "vitest";

import { IntervalStats, SessionLog, StatsIntervalMs } from "../../src/web/session-log.js";
import { KeyStamper, MaxWaitingKeys, Sequencer } from "../../src/web/session-sequencer.js";
import { CyclesPerSecond, fakeProcessor } from "../helpers/session-fakes.js";

const MsCycles = CyclesPerSecond / 1000;
const Start = 1000;
const Mappings = { A: [4, 1], B: [5, 2] };

const cycleAt = (ms) => Start + ms * MsCycles;
const msAt = (cycle) => (cycle - Start) / MsCycles;

// "A+10" is A pressed, stamped 10 ms in; "B-" is B let go with no stamp.
function parseKey(text) {
    const [, name, sign, ms] = text.match(/^([AB])([+-])(\d+)?$/);
    const at = ms === undefined ? undefined : cycleAt(Number(ms));
    return { input: { kind: "key", mapping: Mappings[name], down: sign === "+" }, at };
}

// As parseKey's, with the time the key went in.
const keyText = ({ mapping, down }, cycle) => {
    const name = Object.keys(Mappings).find((each) => Mappings[each].join() === mapping.join());
    return `${name}${down ? "+" : "-"}${msAt(cycle)}`;
};

function sequencing() {
    const processor = fakeProcessor({ cycles: Start });
    const clock = { ms: 0 };
    const now = () => clock.ms;
    const log = new SessionLog({}, now);
    const stats = new IntervalStats(now);
    const commits = [];
    let jumps = 0;
    const sequencer = new Sequencer(processor, {
        log,
        stats: () => stats,
        send: (commit) => commits.push(commit),
        onJump: () => ++jumps,
    });
    const queue = (keys, source = "g1") => {
        for (const text of keys.split(" ")) {
            const { input, at } = parseKey(text);
            sequencer.queue(source, input, { guest: source }, at);
        }
    };
    const run = (count, ms) => {
        for (let i = 0; i < count; ++i) sequencer.execute(ms * MsCycles);
    };
    const applied = () => commits.flatMap(({ at, inputs }) => inputs.map((input) => keyText(input, at)));
    return { processor, clock, log, stats, commits, sequencer, queue, run, applied, jumps: () => jumps };
}

describe("Sequencer", () => {
    it("applies keys with no stamp as they come", () => {
        const { queue, run, applied } = sequencing();
        queue("A+");
        run(1, 50);
        queue("B+");
        run(1, 10);
        queue("A-");
        run(1, 0);
        expect(applied()).toEqual(["A+0", "B+50", "A-60"]);
    });

    it.each([
        ["at their stamps, however the network bunched them", 0, "A+10 A-30 B+30 B-70", 20, "A+10 A-30 B+30 B-70"],
        ["at their stamps through one long execute", 0, "A+10 A-30", 600, "A+10 A-30"],
        ["in the order they came, whatever their stamps say", 0, "A+50 A-20", 20, "A+50 A-50"],
        ["stamped implausibly far ahead at once", 0, "A+3000", 20, "A+0"],
        ["held up as far apart as typed, then on time", 200, "A+10 A-30 B+50 B-300", 20, "A+200 A-220 B+240 B-300"],
        ["held up, making the lag up", 300, "A+10 A-30 B+330 B-360 A+500", 20, "A+300 A-320 B+360 B-390 A+500"],
        ["after an unstamped one at their own stamps", 300, "A+10 A- A+330", 20, "A+300 A-300 A+330"],
    ])("applies keys %s", (_, beforeMs, keys, stepMs, expected) => {
        const { queue, run, applied } = sequencing();
        run(1, beforeMs);
        queue(keys);
        run(600 / stepMs, stepMs);
        expect(applied().join(" ")).toBe(expected);
    });

    it("applies a key too late for its stamp at once, and counts it and how late it was", () => {
        const { clock, stats, queue, run, applied } = sequencing();
        run(1, 50);
        queue("A+10");
        run(1, 0);
        expect(applied()).toEqual(["A+50"]);
        clock.ms = StatsIntervalMs;
        expect(stats.take()).toMatchObject({ lateKeys: 1, lateKeyMaxMs: 40 });
    });

    it("logs a key that waited as it goes in, with its fields, its cycle and when it came", () => {
        const { clock, log, sequencer, run } = sequencing();
        const { input, at } = parseKey("A-40");
        clock.ms = 5;
        sequencer.queue("g1", input, { guest: "g1", stamp: at }, at);
        clock.ms = 35;
        run(3, 20);
        expect(log.events).toEqual([
            { ms: 35, event: "input", guest: "g1", stamp: at, arrivedMs: 5, cycle: at, ...input },
        ]);
    });

    it("keeps keys' stamps across a stop at a breakpoint", () => {
        const { processor, sequencer, queue, run, applied } = sequencing();
        queue("A+21 A-41");
        processor.stopAt = cycleAt(1);
        expect(sequencer.execute(100 * MsCycles)).toBe(false);
        run(4, 20);
        expect(applied()).toEqual(["A+21", "A-41"]);
    });

    it("leaves an execute with nothing waiting as one commit, overshoot and all", () => {
        const { processor, commits, run } = sequencing();
        // As the real processor does: whole instructions, so a little past the target.
        processor.execute = function (count) {
            this.targetCycles += count;
            while (this.currentCycles < this.targetCycles) this.currentCycles += 7;
            return true;
        };
        run(10, 10);
        expect(commits).toHaveLength(10);
        expect(processor.currentCycles - processor.targetCycles).toBeLessThan(7);
    });

    it("applies every key at once when far more are waiting than anyone types, then starts a fresh run", () => {
        const { queue, run, applied } = sequencing();
        for (let i = 0; i <= MaxWaitingKeys; ++i) queue(`A${i % 2 === 0 ? "+" : "-"}${1000 + i * 10}`);
        run(1, 0);
        expect(applied()).toHaveLength(MaxWaitingKeys + 1);
        queue("B+50");
        run(4, 20);
        expect(applied().at(-1)).toBe("B+50");
    });

    it("moves the keys still waiting with the machine when it jumps", () => {
        const { processor, queue, run, applied, jumps } = sequencing();
        queue("A+ A-40");
        processor.currentCycles = processor.targetCycles = cycleAt(500);
        run(1, 20);
        expect(applied()).toEqual(["A+500"]);
        run(2, 10);
        run(1, 0);
        expect(applied()).toEqual(["A+500", "A-540"]);
        expect(jumps()).toBe(1);
    });

    it("starts a source's next key afresh once told to forget it", () => {
        const { sequencer, queue, run, applied } = sequencing();
        run(1, 300);
        queue("A+290");
        run(1, 20);
        sequencer.forget("g1");
        queue("A-330");
        run(3, 20);
        expect(applied()).toEqual(["A+300", "A-330"]);
    });

    it("keeps each source's run of keys apart from the others'", () => {
        const { queue, run, applied } = sequencing();
        run(1, 300);
        queue("A+10", "g1");
        queue("B+310", "g2");
        queue("A-50", "g1");
        run(3, 20);
        expect(applied()).toEqual(["A+300", "B+310", "A-340"]);
    });

    it("says whether a source has keys waiting, and gives them up with their cycles when it goes", () => {
        const { sequencer, queue, run, applied } = sequencing();
        queue("A+");
        expect(sequencer.waiting("g1")).toBe(false);
        queue("A-40");
        expect(sequencer.waiting("g1")).toBe(true);
        expect(sequencer.waiting("g2")).toBe(false);
        expect(sequencer.release("g1")).toEqual([{ ...parseKey("A-40"), fields: { guest: "g1", arrivedMs: 0 } }]);
        expect(sequencer.waiting("g1")).toBe(false);
        run(3, 20);
        expect(applied()).toEqual(["A+0"]);
    });

    it("commits what is due at once and gives up every key waiting, for another sequencer to apply", () => {
        const { sequencer, queue, applied } = sequencing();
        queue("A+ A-40");
        queue("B+20", "g2");
        expect(sequencer.releaseAll()).toEqual([
            { source: "g1", ...parseKey("A-40") },
            { source: "g2", ...parseKey("B+20") },
        ]);
        expect(applied()).toEqual(["A+0"]);
        expect(sequencer.waiting("g1")).toBe(false);
    });

    it("puts an input in at once, ahead of keys still waiting", () => {
        const { sequencer, commits, queue, run } = sequencing();
        queue("A+40");
        sequencer.input({ kind: "break", down: true });
        run(1, 10);
        expect(commits[0]).toMatchObject({ at: Start, inputs: [{ kind: "break", down: true }] });
    });
});

describe("KeyStamper", () => {
    const UpTo = 100000;
    // Cycles in and out as milliseconds past UpTo.
    const stamp = (keys, nowMs, { roundTripMs = 200, sinceCommitMs = 0, upToMs = 0 } = {}) =>
        (keys.stamp({ upTo: UpTo + upToMs * MsCycles, roundTripMs, sinceCommitMs, nowMs }) - UpTo) / MsCycles;
    const follow = (keys, cycleMs, nowMs, heldBack) =>
        (keys.follow({ cycle: UpTo + cycleMs * MsCycles, nowMs, heldBack }) - UpTo) / MsCycles;

    describe("stamping keys for another machine's sequencer", () => {
        it.each([
            ["a round trip, the pause since the last commit and a margin", 30, 250],
            ["no more than a tenth of a second of a pause since the last commit", 5000, 320],
        ])("counts %s past where that sequencer was", (_, sinceCommitMs, expected) => {
            expect(stamp(new KeyStamper(CyclesPerSecond), 0, { sinceCommitMs })).toBe(expected);
        });

        it("keeps keys pressed close together as far apart", () => {
            const keys = new KeyStamper(CyclesPerSecond);
            expect([stamp(keys, 0), stamp(keys, 30, { sinceCommitMs: 30 })]).toEqual([220, 250]);
        });

        it("comes down to a round trip that shrinks a little with each key, never squeezing a tap", () => {
            const keys = new KeyStamper(CyclesPerSecond);
            const shorter = { roundTripMs: 85, upToMs: 0.25 };
            const stamps = [
                stamp(keys, 0),
                stamp(keys, 1000, shorter),
                stamp(keys, 1010, { ...shorter, sinceCommitMs: 10 }),
            ];
            expect(stamps).toEqual([220, 260, 270]);
            expect(keys.catchingUp).toBe(true);
        });
    });

    describe("following on for this machine's own sequencer", () => {
        it("stamps where the machine is when nothing went before", () => {
            const keys = new KeyStamper(CyclesPerSecond);
            expect(follow(keys, 0, 0)).toBe(0);
            expect(keys.catchingUp).toBe(false);
        });

        it("keeps keys held back while control came as far apart as they were pressed, up to the catch-up gap", () => {
            const keys = new KeyStamper(CyclesPerSecond);
            expect(follow(keys, 0, 0, true)).toBe(0);
            expect(keys.catchingUp).toBe(true);
            expect([follow(keys, 0, 30, true), follow(keys, 0, 114, true)]).toEqual([30, 70]);
        });

        it("follows a key stamped ahead until one lands where the machine is", () => {
            const keys = new KeyStamper(CyclesPerSecond);
            expect(stamp(keys, 0)).toBe(220);
            expect(follow(keys, 0, 15)).toBe(235);
            expect(keys.catchingUp).toBe(true);
            expect(follow(keys, 320, 20)).toBe(320);
            expect(keys.catchingUp).toBe(false);
        });

        it("keeps its gap from a key that went in unstamped", () => {
            const keys = new KeyStamper(CyclesPerSecond);
            stamp(keys, 0);
            keys.mark({ cycle: UpTo, nowMs: 0 });
            expect(keys.catchingUp).toBe(false);
            expect(follow(keys, 0, 5)).toBe(5);
        });

        it("starts afresh once reset", () => {
            const keys = new KeyStamper(CyclesPerSecond);
            stamp(keys, 0);
            keys.reset();
            expect(keys.catchingUp).toBe(false);
            expect(follow(keys, -10, 5)).toBe(-10);
        });
    });
});
