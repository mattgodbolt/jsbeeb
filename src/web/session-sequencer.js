// The machine that orders a shared session's inputs: it runs as usual, applies the keys it is
// sent at the cycles they were stamped with, and sends each execute out as a commit for every
// other machine to replay. The host is the sequencer unless someone else has taken control.

import { cycleCount, LockstepHost } from "../lockstep.js";
import { rounded } from "./session-log.js";

// A key stamped further ahead than this is applied at once; an honest stamp, a round trip and the pause since
// the last commit, comes nowhere near it.
const MaxStampAheadSeconds = 2;
// A source with more keys than this waiting for their cycles has them all applied at once instead.
export const MaxWaitingKeys = 64;
// While keys are catching up, on a guest stamping later than it would or on a sequencer applying them later than
// stamped, a gap between two keys longer than this shrinks to it: four of the OS's 10 ms keyboard scans, so each
// key is still seen, while keys pressed closer together stay as close.
const CatchUpGapMs = 40;

/**
 * When the next of a run of keys goes, `at` and no earlier than `earliest`, after the last went at `last.went`
 * `gap` before: as far after it as it was, but with a gap over `catchUp` shortened to it, so a run that has
 * fallen behind its own times makes the lag up a little with each key.
 */
function nextInRun(at, earliest, last, gap, catchUp) {
    const after = last ? last.went + Math.min(gap, catchUp) : -Infinity;
    return Math.max(at, earliest, after, last?.went ?? -Infinity);
}

// A stamp allows this much on top of the round trip for the trip taking longer than it did.
const JitterMarginMs = 20;
// Commits come every few milliseconds from a sequencer running in real time; one that has gone quiet for longer is
// running slowly (hidden, say), and counting the whole pause would stamp keys far beyond where it will be.
const MaxSinceCommitMs = 100;

/**
 * Stamps keys sent to the sequencer with a cycle it will not have passed when they reach it. The sequencer was at
 * `upTo`, the end of the last commit seen here, when it sent it, has run on since it came, and runs on for the trip
 * back, `roundTripMs` in all. When the round trip shrinks, the stamps come down to it as nextInRun says, never going
 * backwards and never squeezing keys pressed close together.
 */
export class KeyStamper {
    constructor(cyclesPerSecond) {
        this.cyclesPerMs = cyclesPerSecond / 1000;
        this.last = null;
    }

    /** Starts afresh, the machine the stamps counted on having jumped. */
    reset() {
        this.last = null;
    }

    /**
     * Stamps a key for this machine's own sequencer at `cycle`, where it is now, but no nearer the last key stamped
     * than they were pressed apart (as nextInRun shortens a long gap), so a key pressed just before taking control,
     * stamped a round trip ahead, keeps its length when its release is pressed after.
     */
    follow({ cycle, nowMs }) {
        const { cyclesPerMs, last } = this;
        const gap = last ? Math.round((nowMs - last.ms) * cyclesPerMs) : 0;
        const stamp = nextInRun(cycle, -Infinity, last && { went: last.at }, gap, CatchUpGapMs * cyclesPerMs);
        this.last = { at: stamp, ms: nowMs };
        return stamp;
    }

    stamp({ upTo, roundTripMs, sinceCommitMs, nowMs }) {
        const { cyclesPerMs, last } = this;
        const aheadMs = roundTripMs + Math.min(sinceCommitMs, MaxSinceCommitMs) + JitterMarginMs;
        const at = upTo + Math.round(aheadMs * cyclesPerMs);
        const gap = last ? Math.round((nowMs - last.ms) * cyclesPerMs) : 0;
        const stamp = nextInRun(at, -Infinity, last && { went: last.at }, gap, CatchUpGapMs * cyclesPerMs);
        this.last = { at: stamp, ms: nowMs };
        return stamp;
    }
}

export class Sequencer {
    /**
     * @param {object} processor
     * @param {object} options
     * @param {import("./session-log.js").SessionLog} options.log where each input is logged as it is applied
     * @param {function(): import("./session-log.js").IntervalStats} options.stats the interval being gathered
     * @param {function(object): void} options.send takes each commit
     * @param {function(): void} options.onJump told when the machine has moved by itself, before the next commit
     * @param {number} [options.rtcBaseMs] the wall time the session's clock counts from, if it has one already
     */
    constructor(processor, { log, stats, send, onJump, rtcBaseMs }) {
        this.processor = processor;
        this.log = log;
        this.stats = stats;
        this.lockstep = new LockstepHost(processor, send, onJump, { rtcBaseMs });
        this.reachedAt = cycleCount(processor);
        // For each source of keys, those waiting for the cycle queue gave them, in the order they came, and the
        // stamp and cycle due of its last stamped key, which the next keeps its gap from.
        this.sources = new Map();
    }

    source(id) {
        let source = this.sources.get(id);
        if (!source) this.sources.set(id, (source = { scheduled: [], lastKey: null }));
        return source;
    }

    snapshot() {
        return this.lockstep.snapshot();
    }

    get rtcBaseMs() {
        return this.lockstep.rtcBaseMs;
    }

    // Logged with the cycle it is applied at: the machine is between two of the lockstep's executes.
    input(input, fields = {}) {
        this.log.record("input", { ...fields, ...input, cycle: cycleCount(this.processor) });
        this.lockstep.input(input);
    }

    /**
     * Applies a key from source `id` at the cycle `at` it was stamped with, or at once if it has none. A key too
     * late for its cycle goes in as soon as it can, and the ones after it keep their gaps from it, as nextInRun
     * says, so a bunch held up past its cycles goes in as far apart as it was typed and the lag is made up over
     * the keys that follow.
     */
    queue(id, input, fields, at) {
        this.followJump();
        const source = this.source(id);
        const now = cycleCount(this.processor);
        const cyclesPerMs = this.processor.model.cyclesPerSecond / 1000;
        const stamped = at !== undefined && at <= now + MaxStampAheadSeconds * 1000 * cyclesPerMs;
        let due = Math.max(now, source.scheduled.at(-1)?.at ?? now);
        if (stamped) {
            if (at < now) {
                this.stats().count("lateKeys");
                this.stats().peak("lateKeyMaxMs", rounded((now - at) / cyclesPerMs));
            }
            const last = source.lastKey;
            due = nextInRun(at, due, last && { went: last.due }, last ? at - last.at : 0, CatchUpGapMs * cyclesPerMs);
            source.lastKey = { at, due };
        } else {
            source.lastKey = null;
        }
        if (due === now && source.scheduled.length === 0) {
            this.input(input, fields);
            return;
        }
        source.scheduled.push({ input, at: due, fields: { ...fields, arrivedMs: this.log.elapsed() } });
        if (source.scheduled.length > MaxWaitingKeys) {
            for (const key of source.scheduled.splice(0)) this.input(key.input, key.fields);
            source.lastKey = null;
        }
    }

    /** Starts source `id`'s next key afresh, its stamps now counting on a machine that has been replaced. */
    forget(id) {
        const source = this.sources.get(id);
        if (source) source.lastKey = null;
    }

    /** The keys source `id` still has waiting, each with the cycle it was due at, which are dropped with it. */
    release(id) {
        const waiting = this.sources.get(id)?.scheduled ?? [];
        this.sources.delete(id);
        return waiting;
    }

    /**
     * Commits what is due where the machine is now (BREAK, say), and gives up every key still waiting for its cycle,
     * as `{ source, input, at }`, for another sequencer to apply.
     */
    releaseAll() {
        if (this.lockstep.pending.length > 0) this.lockstep.execute(0);
        const waiting = [...this.sources].flatMap(([source, { scheduled }]) =>
            scheduled.map(({ input, at }) => ({ source, input, at })),
        );
        this.sources.clear();
        return waiting;
    }

    // The machine only moves between executes by jumping (a reset, a loaded state), and the keys still
    // waiting, due on the old cycle count, move with it.
    followJump() {
        const jump = cycleCount(this.processor) - this.reachedAt;
        if (jump === 0) return;
        this.reachedAt += jump;
        for (const source of this.sources.values()) for (const key of source.scheduled) key.at += jump;
    }

    // While keys are waiting, the cycles asked for run in pieces that end where the next is due, each its
    // own commit, so a long execute cannot bring keys spaced apart back onto one cycle. The pieces add up
    // to what was asked, so the processor's overshoot carries over as it does in one execute.
    execute(cycles) {
        this.followJump();
        let remaining = cycles;
        let running;
        for (;;) {
            const now = cycleCount(this.processor);
            let nextAt = Infinity;
            for (const source of this.sources.values()) {
                while (source.scheduled.length > 0 && source.scheduled[0].at <= now) {
                    const { input, fields } = source.scheduled.shift();
                    this.input(input, fields);
                }
                if (source.scheduled.length > 0) nextAt = Math.min(nextAt, source.scheduled[0].at);
            }
            const piece = Math.min(remaining, nextAt - now);
            running = this.lockstep.execute(piece);
            this.reachedAt = cycleCount(this.processor);
            remaining -= piece;
            if (!running || remaining <= 0) break;
        }
        return running;
    }
}
