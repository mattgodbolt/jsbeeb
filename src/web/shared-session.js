// A shared session in the browser: one machine, the host's unless someone
// has taken control, runs as usual, and its inputs and cycles stream to the
// others over the links session-transport.js opens. `?server=<room>` hosts and `?client=<room>`
// joins. See docs/shared-sessions-design.md for the protocol and its limits.

import { humanId } from "human-id";

import {
    cycleCount,
    isValidCommit,
    isValidInput,
    LockstepGuest,
    MaxGuestLagSeconds,
    restoreSessionSnapshot,
    sessionSnapshot,
} from "../lockstep.js";
import { AdcCentreValue } from "../adc.js";
import { findModel } from "../models.js";
import { buildUrlFromParams } from "../url-params.js";
import { isSameModel, snapshotFromJSON, snapshotToJSON } from "../snapshot.js";
import { matchesHost, parameterFor, readTakenFromHost, urlParamType } from "./parameters.js";
import { IntervalStats, numbersFrom, rounded, SessionLog, StatsIntervalMs } from "./session-log.js";
import { LaggingMs, PeerStates, peerState } from "./session-panel.js";
import { KeyStamper, Sequencer } from "./session-sequencer.js";
import { note } from "./analytics.js";
import { countBucket } from "./analytics-filters.js";

const PasteWaitMs = 500;
export const MinResyncIntervalMs = 2000;
const SnapshotChunkBytes = 16 * 1024;
const MaxSnapshotBytes = 64 * 1024 * 1024;
const RoomGone = 404;
const RoomTaken = 409;
const TooManyOffers = 429;
// The rendezvous's own rule for an ID.
const RoomName = /^[A-Za-z0-9_-]{1,64}$/;
// A generated room's name is three words; one taken already is a rare clash, and another name will do.
const MaxRoomNameTries = 3;
// Keys are stamped with a round trip not yet measured as this.
const UnmeasuredRttMs = 200;
// A guest in control that sends no commit for this long has stalled, or its connection has, and the host takes
// control back.
const ControllerSilentMs = 3000;

const MaxReasonLength = 200;
const MaxNameLength = 32;
// What a guest's summary may hold; anything else it sends is dropped, so it cannot rewrite the host's log.
const GuestStatsKeys = [
    "frames",
    "framesMaxGapMs",
    "commits",
    "commitsMaxGapMs",
    "lagMs",
    "maxLagMs",
    "starved",
    "catchingUp",
    "hiddenFrames",
    "longTasks",
    "longTaskMaxMs",
    "stampAheadMs",
    "desyncs",
];
// A guest sends a summary each StatsIntervalMs; more often than this, the rest are dropped.
const MinGuestStatsIntervalMs = StatsIntervalMs / 2;
// Far more guests than a session can hold, so a hostile host cannot flood a guest's lights.
const MaxRosterGuests = 16;
// A guest that has left keeps its light this long, so a drop is seen even by someone who looked away.
const LeftShownMs = 30000;

/** Why a session failed or ended, in terms general enough to report. */
export const SessionFailures = Object.freeze({
    protocol: "protocol",
    restoreFailed: "restore_failed",
    timeout: "timeout",
    serviceUnavailable: "service_unavailable",
    roomTaken: "room_taken",
    noRoom: "no_room",
    tooManyJoining: "too_many_joining",
    alreadyWaiting: "already_waiting",
    unsupportedMachine: "unsupported_machine",
    hostLeft: "host_left",
    pageClosed: "page_closed",
    other: "other",
});

/** Notes a session reaching `stage`; `reason` is one of `SessionFailures`, never words. */
function noteStage(role, stage, { reason, peers } = {}) {
    note("session", { role, stage, reason, peers: peers === undefined ? undefined : countBucket(peers) });
}

/**
 * Tells this person of the session's `desyncs`th desync: `what` desynced, and why. A second is a bug rather than a
 * blip, so it asks for the report from `other` too; any after are only logged, so a machine that keeps desyncing
 * does not bury the page in toasts.
 */
function announceDesync(notify, desyncs, what, reason, other) {
    if (desyncs === 1) notify(`${what}: ${reason}. Resyncing; please save a session report.`);
    if (desyncs === 2) {
        notify(
            `Another desync. ${what}: ${reason}. More than one in a session is a bug: please save a session report ` +
                `here and on ${other}, and send both with a bug report.`,
        );
    }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const gzipCodec = Object.freeze({
    async compress(text) {
        const stream = new Response(text).body.pipeThrough(new CompressionStream("gzip"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    },
    async decompress(bytes) {
        return new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"))).text();
    },
});

function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

const mappingKey = (mapping) => mapping.join(",");

export const randomName = () => humanId({ separator: "-", capitalize: false });

// The control characters, and the bidirectional ones that could reorder a name among others.
// eslint-disable-next-line no-control-regex
const Unprintable = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** What to call someone, from a name they or a peer gave, or null if it has nothing printable. */
export function cleanName(name) {
    if (typeof name !== "string") return null;
    const printable = name.replace(Unprintable, "").trim();
    // By code point, so a surrogate pair is never split.
    return [...printable].slice(0, MaxNameLength).join("") || null;
}

/** The matrix positions, as `[col, row]`, of the keys the machine has down. */
const keysDown = (sysvia) =>
    sysvia.keys.flatMap((column, col) => [...column.keys()].filter((row) => column[row]).map((row) => [col, row]));

/**
 * Keyboard input for a session: keys are mapped to the matrix here, with this
 * person's layout, or come as matrix positions from a paste, and are handed to
 * `send` as session inputs. BREAK goes too only if `allowBreak`.
 */
export function sessionInput(sysvia, send, { allowBreak }) {
    const keyInput = (mapping, down) => ({
        kind: "key",
        mapping: [...mapping],
        down,
    });
    return {
        keyDown(key, shiftDown) {
            const mapping = sysvia.keyMapping(key, !!shiftDown);
            if (mapping) send(keyInput(mapping, true));
        },
        // As SysVia.keyUp: the key is released under both of its mappings.
        keyUp(key) {
            for (const shiftDown of [true, false]) {
                const mapping = sysvia.keyMapping(key, shiftDown);
                if (mapping) send(keyInput(mapping, false));
            }
        },
        keyRaw(colRow, down) {
            send(keyInput(colRow, down));
        },
        setReset(down) {
            if (allowBreak) send({ kind: "break", down });
        },
        // Only this person's keys are theirs to let go, and they are released one by one.
        clearKeys() {},
    };
}

// Each machine's ADC reads its own browser's gamepad, mouse and microphone, which
// no other machine has, and the OS converts continuously into RAM; so in a session
// every channel reads the centre.
function holdAnalogue(processor, held) {
    processor.adconverter.setFixedValue(held ? AdcCentreValue : null);
}

/** A parsed message from a peer, or null for anything that is not a JSON object. */
function parsed(data) {
    try {
        const message = JSON.parse(data);
        return message && typeof message === "object" ? message : null;
    } catch {
        return null;
    }
}

/**
 * Everything a session needs from the page, gathered once in main.js.
 * @typedef {object} SessionContext
 * @property {object} processor
 * @property {object} model
 * @property {object} takenFromHost - the page's takenFromHostValues, as its start gave them
 * @property {import("./emulation-loop.js").EmulationLoop} loop
 * @property {import("./keyboard.js").Keyboard} keyboard
 * @property {string} version
 * @property {ReturnType<typeof import("./session-transport.js").webRtcTransport>} transport
 * @property {{compress: function(string): Promise<Uint8Array>, decompress: function(Uint8Array): Promise<string>}} codec
 * - how a snapshot is packed for the wire: `gzipCodec`
 * @property {import("./session-page.js").SessionPage} page
 */

export class SessionHost {
    constructor(context, room, name = randomName()) {
        this.context = context;
        this.room = room;
        this.name = name;
        this.guests = new Map();
        this.listening = null;
        this.closed = false;
        this.closing = new AbortController();
        this.log = new SessionLog({ role: "host", room, name, model: context.model.name, version: context.version });
        this.stats = new IntervalStats();
        this.guestsSeen = 0;
        this.guestsJoined = 0;
        this.departed = [];
        this.desyncs = 0;
        // Who orders the session's inputs: the host (null) or a guest. While a guest does, this machine replays
        // its commits as a guest's does, and this page's keys go to it stamped as a guest's go to the host.
        this.controller = null;
        this.sequencer = null;
        this.replay = null;
        // Whether the guest in control is being asked to stop; and who is to take over once control has changed
        // hands (null for the host).
        this.releasing = false;
        this.taker = null;
        // The cycle this machine takes control back at, once its replay has reached it.
        this.resumeAt = null;
        // Keys for whoever is next in control, while nobody is; and those sent to the guest in control that no commit
        // of its has carried yet, which the host applies itself if that guest goes.
        this.heldBack = [];
        this.forwarded = [];
        // A guest in control that went before stopping, to be resynced once the host has control again.
        this.resyncWhenResumed = null;
        this.stamper = new KeyStamper(context.model.cyclesPerSecond);
        this.lastCommitMs = 0;
        // Whether a key press takes control, for everyone: the host's to set, and sent to every guest.
        this.takeOnKey = false;
        this.panel = context.page.panel(this, (on) => this.setTakeOnKey(on));
        this.panel.showTakeOnKey(this.takeOnKey);
    }

    setTakeOnKey(on) {
        this.takeOnKey = on;
        this.log.record("take on key", { on });
        this.showStatus();
    }

    /** @param {string} [secret] the room's, if it has been made already */
    async start(secret) {
        const { processor, loop, keyboard, transport, page } = this.context;
        while (keyboard.isPasting) await delay(PasteWaitMs);
        const roomSecret = secret ?? (await transport.createRoom(this.room));
        this.sequence();
        loop.setLockstep({ execute: (cycles) => this.execute(cycles) });
        keyboard.setInput(sessionInput(processor.sysvia, (input) => this.input(input), { allowBreak: true }));
        holdAnalogue(processor, true);
        page.onPageHide(() => this.close(), this.closing.signal);
        page.notify(`Hosting "${this.room}". Guests join at ${page.joinLink(this.room)}`);
        this.panel.open();
        this.log.record("hosting");
        noteStage(this.log.details.role, "created");
        this.stopWatchingPage = page.watch(this.log, () => this.stats);
        this.listening = transport.listen(this.room, roomSecret, {
            connecting: (id, link) => this.connecting(id, link),
            reopened: () => {
                page.notify(`The room "${this.room}" had expired, and is open again.`);
                this.log.record("room reopened");
            },
            gone: (error) => {
                page.notify(`The room "${this.room}" has gone, so nobody else can join: ${error.message}`);
                this.log.record("room gone", { reason: error.message });
            },
        });
    }

    sequence(rtcBaseMs) {
        this.sequencer = new Sequencer(this.context.processor, {
            log: this.log,
            stats: () => this.stats,
            send: (commit) => this.broadcast(JSON.stringify(commit)),
            onJump: () => this.resyncEveryone(),
            rtcBaseMs,
        });
        this.replay = null;
        this.resumeAt = null;
        for (const { source, input, fields, at } of this.heldBack.splice(0))
            this.sequencer.queue(source, input, fields, at);
    }

    /** This page's own keys. BREAK is the host's alone, so it takes control back first. */
    input(input) {
        if (input.kind === "break" && !this.sequencer) this.takeBackNow("the host pressed BREAK");
        if (input.kind === "break") {
            this.sequencer.input(input);
            return;
        }
        if (input.down && !this.sequencer && this.takeOnKey) this.requestControl(null);
        this.deliverKey("host", input, {}, this.stampForController() ?? this.stampOwn());
    }

    // A key, a guest's or this page's, goes to whoever orders the inputs, or waits for them while control is
    // changing hands.
    deliverKey(source, input, fields, at) {
        if (this.sequencer) this.sequencer.queue(source, input, fields, at);
        else if (this.controller && !this.releasing) this.forward(this.controller, { source, input, fields, at });
        else this.heldBack.push({ source, input, fields, at });
    }

    forward(guest, key) {
        this.forwarded.push(key);
        this.sendTo(guest, JSON.stringify({ type: "input", input: key.input, at: key.at, source: key.source }));
    }

    // This page's own keys go in at once, as on a machine of its own, except while control is coming back to it or
    // its keys are catching up after: then they keep their gaps, so none is cut short.
    stampOwn() {
        const now = { cycle: cycleCount(this.context.processor), nowMs: this.log.elapsed() };
        if (!this.sequencer) return this.stamper.follow({ ...now, heldBack: true });
        if (this.stamper.catchingUp || this.sequencer.waiting("host")) return this.stamper.follow(now);
        this.stamper.mark(now);
        return undefined;
    }

    stampForController() {
        if (!this.controller || this.releasing) return undefined;
        const nowMs = this.log.elapsed();
        return this.stamper.stamp({
            upTo: this.replay.upTo,
            roundTripMs: this.controller.rttMs ?? UnmeasuredRttMs,
            sinceCommitMs: nowMs - this.lastCommitMs,
            nowMs,
        });
    }

    /**
     * Gives control to `taker`, a guest, or takes it for the host if null. Asked while control is changing hands, it
     * goes to whoever asked last once it has.
     */
    requestControl(taker) {
        if (this.releasing || this.resumeAt !== null) {
            this.taker = taker;
            return;
        }
        // A guest whose snapshot is still on its way would have it undo the handover, so it waits for it.
        if (taker && !taker.ready) {
            this.taker = taker;
            return;
        }
        this.taker = null;
        if (taker === this.controller && this.resumeAt === null) return;
        if (this.sequencer) {
            if (taker) this.handOver(taker);
            return;
        }
        if (!this.controller) return;
        this.releasing = true;
        this.taker = taker;
        this.sendTo(this.controller, JSON.stringify({ type: "release" }));
    }

    // Between two executes, so the machine is at the end of the last commit, where the guest carries on from.
    handOver(guest) {
        const { processor } = this.context;
        const at = cycleCount(processor);
        const rtcBaseMs = this.sequencer?.rtcBaseMs ?? this.rtcBaseMs;
        const waiting = this.sequencer ? this.sequencer.releaseAll() : [];
        this.sequencer = null;
        this.rtcBaseMs = rtcBaseMs;
        this.replay = new LockstepGuest(processor, (reason, dropped, moved, evidence) => {
            if (moved) {
                this.takeBackNow(reason, { jumped: true, unreplayed: dropped });
                return;
            }
            this.log.record("desync", { guest: guest.id, reason, ...evidence });
            announceDesync(
                this.context.page.notify,
                ++this.desyncs,
                `This machine desynced from ${guestName(guest)}, which was in control, and took control back`,
                reason,
                `${guestName(guest)}'s machine`,
            );
            this.takeBackNow(reason, { unreplayed: dropped, announce: false });
        });
        this.controller = guest;
        this.lastCommitMs = this.log.elapsed();
        this.stamper.reset();
        this.log.record("control", { guest: guest.id, at });
        this.sendTo(guest, JSON.stringify({ type: "handover", at }));
        this.forwarded = [];
        for (const key of [...waiting, ...this.heldBack.splice(0)]) this.forward(guest, { fields: {}, ...key });
        this.showStatus();
    }

    // The guest in control has stopped at `at`, the end of its last commit, with `waiting` keys it had not applied.
    released(guest, { at, waiting }) {
        if (guest !== this.controller || !this.releasing) return;
        if (at !== this.replay.upTo) {
            this.takeBackNow(`${guestName(guest)} stopped at ${at}, not at the end of its last commit`);
            return;
        }
        const keys = Array.isArray(waiting) ? waiting.flatMap((key) => checkedKey(key) ?? []) : [];
        this.forwarded = [];
        this.heldBack.unshift(...keys.map((key) => ({ ...key, fields: { guest: key.source } })));
        this.releasing = false;
        const taker = this.taker;
        this.taker = null;
        this.controller = null;
        if (taker && this.guests.get(taker.id) === taker && taker.ready) {
            this.handOverFrom(taker, at);
        } else {
            this.taker = taker;
            this.resumeAt = at;
            this.log.record("control", { guest: "host", at });
        }
    }

    // As handOver, but from a guest that has just stopped, which this machine's replay may not yet have reached.
    handOverFrom(guest, at) {
        this.controller = guest;
        this.lastCommitMs = this.log.elapsed();
        this.stamper.reset();
        this.log.record("control", { guest: guest.id, at });
        this.sendTo(guest, JSON.stringify({ type: "handover", at }));
        this.forwarded = [];
        for (const key of this.heldBack.splice(0)) this.forward(guest, key);
        this.showStatus();
    }

    /**
     * Takes control back from a guest that has left or gone quiet, from the end of its last commit, which every
     * other guest has been sent too; anything it sends after is ignored, and a snapshot puts it right.
     */
    takeBack(reason) {
        if (!this.controller) return;
        const former = this.controller;
        this.log.record("control", { guest: "host", reason });
        this.context.page.notify(`The host has control again: ${reason}.`);
        this.controller = null;
        this.releasing = false;
        this.heldBack.unshift(...this.forwarded.splice(0));
        this.resumeAt = this.replay.upTo;
        this.resyncWhenResumed = former;
        this.showStatus();
    }

    /**
     * Takes control back where this machine is now, and starts everyone afresh from it. The keys in commits it has
     * passed on but not yet replayed (`unreplayed`, if its replay has already dropped them) go in at once, so a
     * release among them is not lost; after a `jumped` machine, the session's clock starts again from the wall
     * time, as it does when the host's machine jumps in control.
     */
    takeBackNow(reason, { jumped = false, unreplayed = this.replay?.commits ?? [], announce = true } = {}) {
        if (this.sequencer) return;
        this.log.record("control", { guest: "host", reason });
        if (announce) this.context.page.notify(`The host has taken control back: ${reason}.`);
        this.controller = null;
        this.releasing = false;
        this.taker = null;
        this.resyncWhenResumed = null;
        if (jumped) this.stamper.reset();
        const relayed = unreplayed.flatMap(({ inputs }) => inputs);
        this.heldBack.unshift(
            ...relayed.map((input) => ({ source: "relayed", input, fields: {}, at: undefined })),
            ...this.forwarded.splice(0),
        );
        this.sequence(jumped ? undefined : this.rtcBaseMs);
        this.resyncEveryone();
        this.showStatus();
    }

    // A commit from the guest in control: checked as a guest checks the host's, replayed here, and passed on.
    relay(guest, message) {
        if (guest !== this.controller || this.sequencer) return;
        const inputs = Array.isArray(message.inputs) ? message.inputs : [];
        if (
            !isValidCommit(message) ||
            inputs.some((input) => input.kind !== "key") ||
            message.at !== this.replay.upTo
        ) {
            this.takeBackNow(`${guestName(guest)} sent a commit that does not follow on`);
            return;
        }
        const commit = {
            type: "commit",
            at: message.at,
            inputs: inputs.map(({ kind, mapping, down }) => ({ kind, mapping: [...mapping], down })),
            upTo: message.upTo,
            ...(message.hash !== undefined && { hash: message.hash }),
        };
        for (const { mapping, down } of commit.inputs) {
            const index = this.forwarded.findIndex(
                ({ input }) => input.down === down && mappingKey(input.mapping) === mappingKey(mapping),
            );
            if (index >= 0) this.forwarded.splice(index, 1);
        }
        const relayed = JSON.stringify(commit);
        this.lastCommitMs = this.log.elapsed();
        this.replay.receive(commit);
        for (const other of this.guests.values()) {
            if (other === guest) continue;
            if (other.ready) this.sendTo(other, relayed);
            else if (other.welcomed) other.backlog.push(relayed);
        }
    }

    execute(cycles) {
        const { processor } = this.context;
        let running;
        if (this.sequencer) {
            running = this.sequencer.execute(cycles);
        } else {
            running = this.replay.execute(cycles);
            if (this.resumeAt !== null && this.replay.behind() === 0 && cycleCount(processor) === this.resumeAt) {
                const former = this.resyncWhenResumed;
                this.resyncWhenResumed = null;
                this.sequence(this.rtcBaseMs);
                if (former && this.guests.get(former.id) === former) this.sendSnapshot(former);
                const taker = this.taker;
                this.taker = null;
                if (taker && this.guests.get(taker.id) === taker) this.requestControl(taker);
                this.showStatus();
            } else if (this.controller && this.log.elapsed() - this.lastCommitMs > ControllerSilentMs) {
                this.takeBack(`${guestName(this.controller)} went quiet`);
            }
        }
        this.stats.tick("frames");
        if (this.context.page.hidden()) this.stats.count("hiddenFrames");
        const summary = this.stats.take();
        if (summary) {
            this.log.record("stats", summary);
            for (const guest of this.guests.values()) {
                if (!guest.welcomed) continue;
                guest.link.stats().then(
                    (stats) => {
                        guest.rttMs = stats.rttMs;
                        this.log.record("connection", { guest: guest.id, ...stats });
                    },
                    () => {},
                );
            }
            this.showStatus();
        }
        return running;
    }

    // Every guest is shown the same lights as the host, its own marked, since it can see only its link to the host.
    showStatus() {
        const nowMs = this.log.elapsed();
        this.departed = this.departed.filter((guest) => nowMs - guest.leftMs < LeftShownMs);
        const views = [...this.guests.values(), ...this.departed].map((guest) => [guest, this.guestView(guest, nowMs)]);
        const count = this.connectedCount();
        // Behind only a guest in control, whose commits this machine is replaying.
        const cyclesPerMs = this.context.processor.model.cyclesPerSecond / 1000;
        const lagMs = this.replay ? Math.round(this.replay.behind() / cyclesPerMs) : undefined;
        const self = {
            label: `${this.name} (you)`,
            state: lagMs > LaggingMs ? "lagging" : "ok",
            lagMs,
            control: !this.controller,
        };
        this.panel.show("hosting", `${count} ${count === 1 ? "guest" : "guests"}`, [
            self,
            ...views.map(([, view]) => view),
        ]);
        this.panel.showControl(this.controller ? guestName(this.controller) : "you", !!this.controller);
        for (const guest of [...this.guests.values()]) {
            if (!guest.welcomed) continue;
            const guests = views.map(([each, view]) => (each === guest ? { ...view, you: true } : view));
            this.sendTo(guest, JSON.stringify({ type: "roster", guests, takeOnKey: this.takeOnKey }));
        }
    }

    guestView(guest, nowMs) {
        const state = peerState({
            connected: guest.welcomed,
            left: guest.leftMs !== undefined,
            stats: guest.stats,
            statsAgeMs: nowMs - guest.statsMs,
        });
        const { rttMs, leftReason } = guest;
        const control = guest === this.controller;
        return { label: guestName(guest), state, rttMs, lagMs: guest.stats?.lagMs, leftReason, control };
    }

    // A key stamped before the guest's latest snapshot (`snapshots` is how many it had restored) belongs to a
    // machine that has since been replaced, so it goes in at once.
    queueKey(guest, input, fields, { at, snapshots }) {
        this.deliverKey(guest.id, input, fields, snapshots === guest.snapshotsSent ? at : undefined);
    }

    connectedCount() {
        return [...this.guests.values()].filter((guest) => guest.welcomed).length;
    }

    connecting(id, link) {
        const guest = {
            id,
            number: ++this.guestsSeen,
            name: null,
            saidHello: false,
            stats: null,
            statsMs: -Infinity,
            // Summaries that came too soon after the last, counted in the next one logged.
            statsDropped: 0,
            rttMs: undefined,
            link,
            welcomed: false,
            ready: false,
            backlog: [],
            held: new Map(),
            // Snapshots sent in full, which the guest counts as it restores them; a key stamped before the
            // latest belongs to a machine that has since been replaced.
            snapshotsSent: 0,
            lastSnapshotMs: 0,
            snapshotGeneration: 0,
            resyncTimer: null,
        };
        this.guests.set(id, guest);
        this.log.record("offer", { guest: id });
        this.showStatus();
        return {
            message: (data) => this.fromGuest(guest, data),
            closed: (reason) => this.drop(guest, reason),
        };
    }

    // Sent once the guest has said hello: Chrome reports a channel the guest opened as open before it can carry
    // anything, and silently drops what is sent on it until it can.
    welcome(guest) {
        const { model, takenFromHost, version } = this.context;
        const welcome = { type: "welcome", model: model.name, takenFromHost, version, name: this.name };
        if (!this.sendTo(guest, JSON.stringify(welcome))) return;
        guest.welcomed = true;
        this.sendSnapshot(guest);
        this.context.page.notify(`A guest joined (${this.connectedCount()} connected).`);
        this.log.record("joined", { guest: guest.id });
        ++this.guestsJoined;
        noteStage(this.log.details.role, "connected", { peers: this.connectedCount() });
        this.showStatus();
    }

    fromGuest(guest, data) {
        const message = parsed(data);
        if (!message) return;
        if (message.type === "input" && message.input?.kind === "key" && isValidInput(message.input)) {
            // Rebuilt from the checked fields, since every other guest is sent it too.
            const mapping = [...message.input.mapping];
            const { down } = message.input;
            if (down) guest.held.set(mappingKey(mapping), mapping);
            else guest.held.delete(mappingKey(mapping));
            // The guest in control applies its own keys; they come here only so they can be let go if it leaves.
            if (message.own) return;
            if (down && message.take) this.requestControl(guest);
            const guestMs = Number.isFinite(message.ms) ? message.ms : undefined;
            const at = Number.isSafeInteger(message.at) ? message.at : undefined;
            this.queueKey(
                guest,
                { kind: "key", mapping, down },
                { guest: guest.id, guestMs, stamp: at },
                {
                    at,
                    snapshots: message.snapshots,
                },
            );
        } else if (message.type === "hello" && !guest.saidHello) {
            guest.saidHello = true;
            guest.name = cleanName(message.name);
            this.log.record("hello", { guest: guest.id, name: guest.name });
            this.welcome(guest);
        } else if (message.type === "stats" && this.log.elapsed() - guest.statsMs < MinGuestStatsIntervalMs) {
            ++guest.statsDropped;
        } else if (message.type === "stats") {
            guest.stats = numbersFrom(message.stats, GuestStatsKeys);
            guest.statsMs = this.log.elapsed();
            this.log.record("guest stats", { ...guest.stats, guest: guest.id, dropped: guest.statsDropped });
            guest.statsDropped = 0;
        } else if (message.type === "commit") {
            this.relay(guest, message);
        } else if (message.type === "take") {
            this.requestControl(guest);
        } else if (message.type === "released") {
            this.released(guest, message);
        } else if (message.type === "bye") {
            this.drop(guest, "it said goodbye");
        } else if (message.type === "resync") {
            this.requestSnapshot(guest, String(message.reason).slice(0, MaxReasonLength));
        }
    }

    // A guest asks once per desync, but a buggy or hostile one could ask without end,
    // and each snapshot costs the host's main thread. One already on its way will do.
    requestSnapshot(guest, reason) {
        if (!guest.ready || guest.resyncTimer) return;
        this.log.record("resync asked", { guest: guest.id, reason });
        const name = guestName(guest);
        announceDesync(this.context.page.notify, ++this.desyncs, `${name} desynced`, reason, `${name}'s machine`);
        const waitMs = guest.lastSnapshotMs + MinResyncIntervalMs - Date.now();
        if (waitMs <= 0) {
            this.sendSnapshot(guest);
            return;
        }
        guest.resyncTimer = setTimeout(() => {
            guest.resyncTimer = null;
            this.sendSnapshot(guest);
        }, waitMs);
    }

    // Nobody can replay their way across a jump, not even a guest whose snapshot is still
    // being compressed: that one is from before it.
    resyncEveryone() {
        this.log.record("jump", { cycle: cycleCount(this.context.processor) });
        for (const guest of this.guests.values()) {
            if (guest.welcomed) this.sendSnapshot(guest);
        }
    }

    // Taken between two executes, or at a jump before the next one: either way the next
    // commit starts here, so anything the guest is sent from now on carries on from it.
    // Commits made while the snapshot is compressed wait in the guest's backlog, and a
    // newer snapshot for the same guest supersedes this one.
    async sendSnapshot(guest) {
        const generation = ++guest.snapshotGeneration;
        clearTimeout(guest.resyncTimer);
        guest.resyncTimer = null;
        guest.ready = false;
        guest.lastSnapshotMs = Date.now();
        const startMs = this.log.elapsed();
        const { snapshot, pending } = this.currentSnapshot();
        guest.backlog = pending;
        const json = snapshotToJSON(snapshot);
        const takeMs = rounded(this.log.elapsed() - startMs);
        const bytes = await this.context.codec.compress(json);
        if (generation !== guest.snapshotGeneration) return;
        const tookMs = rounded(this.log.elapsed() - startMs);
        this.log.record("snapshot", { guest: guest.id, bytes: bytes.length, takeMs, tookMs });
        if (!this.sendTo(guest, JSON.stringify({ type: "snapshot", bytes: bytes.length }))) return;
        for (let offset = 0; offset < bytes.length; offset += SnapshotChunkBytes) {
            if (!this.sendTo(guest, bytes.slice(offset, offset + SnapshotChunkBytes))) return;
        }
        ++guest.snapshotsSent;
        this.sequencer?.forget(guest.id);
        for (const commit of guest.backlog) {
            if (!this.sendTo(guest, commit)) return;
        }
        guest.backlog = [];
        guest.ready = true;
        if (this.taker === guest) {
            this.taker = null;
            this.requestControl(guest);
        }
    }

    /**
     * This machine as a guest is to become it, and the commits that carry on from it: none while it orders the
     * inputs, and while a guest does, those it has relayed but not yet replayed, the first cut to start here.
     */
    currentSnapshot() {
        if (this.sequencer) return { snapshot: this.sequencer.snapshot(), pending: [] };
        const at = cycleCount(this.context.processor);
        const pending = this.replay.commits.map((commit) =>
            JSON.stringify(commit.at < at ? { ...commit, at, inputs: [] } : commit),
        );
        return { snapshot: sessionSnapshot(this.context.processor, this.rtcBaseMs), pending };
    }

    /** Sends, or drops a guest whose link has gone or whose send buffer is full. */
    sendTo(guest, data) {
        try {
            guest.link.send(data);
            return true;
        } catch (error) {
            console.warn(`Shared session: dropping a guest: ${error.message}`);
            this.drop(guest, `sending to it failed: ${error.message}`);
            return false;
        }
    }

    broadcast(commit) {
        for (const guest of this.guests.values()) {
            if (guest.ready) this.sendTo(guest, commit);
            else if (guest.welcomed) guest.backlog.push(commit);
        }
    }

    // Every key the guest is holding, or whose release is still waiting, is let go, or it would stay down.
    releaseKeys(guest) {
        const releases = new Map(guest.held);
        const waiting = this.sequencer ? this.sequencer.release(guest.id) : [];
        for (const { input } of waiting) releases.set(mappingKey(input.mapping), input.mapping);
        for (const mapping of releases.values())
            this.deliverKey(guest.id, { kind: "key", mapping, down: false }, { guest: guest.id }, undefined);
    }

    drop(guest, reason) {
        if (this.guests.get(guest.id) !== guest) return;
        this.guests.delete(guest.id);
        this.log.record("left", { guest: guest.id, reason });
        guest.leftMs = this.log.elapsed();
        guest.leftReason = reason;
        this.departed.push(guest);
        if (this.taker === guest) this.taker = null;
        if (guest === this.controller) this.takeBack(`${guestName(guest)} left`);
        this.showStatus();
        clearTimeout(guest.resyncTimer);
        this.releaseKeys(guest);
        guest.link.close();
        if (guest.welcomed)
            this.context.page.notify(`${guest.name ?? "A guest"} left (${this.connectedCount()} connected).`);
    }

    // A page kept for the back button comes back as an ordinary one. The keys let go
    // as the keyboard leaves the session, BREAK among them, are applied before the loop does.
    close() {
        if (this.closed) return;
        this.closed = true;
        this.listening?.close();
        this.closing.abort();
        this.stopWatchingPage?.();
        const { processor, loop, keyboard } = this.context;
        keyboard.setInput(null);
        if (!this.sequencer) this.sequence(this.rtcBaseMs);
        for (const guest of this.guests.values()) this.releaseKeys(guest);
        this.sequencer.execute(0);
        loop.setLockstep(null);
        for (const guest of this.guests.values()) {
            clearTimeout(guest.resyncTimer);
            guest.link.close();
        }
        holdAnalogue(processor, false);
        processor.sysvia.cmos.leaveSession();
        this.log.record("closed");
        noteStage(this.log.details.role, "ended", { reason: SessionFailures.pageClosed, peers: this.guestsJoined });
    }

    report() {
        return this.log.report({
            keysDown: keysDown(this.context.processor.sysvia),
            guests: [...this.guests.values()].map((guest) => ({
                id: guest.id,
                connected: guest.welcomed,
                held: [...guest.held.values()],
            })),
        });
    }
}

export class SessionGuest {
    constructor(context, room, name = randomName()) {
        this.context = context;
        this.room = room;
        this.name = name;
        this.hostName = null;
        this.id = randomId();
        this.link = null;
        this.lockstep = null;
        this.incoming = null;
        this.buffering = null;
        this.restored = Promise.resolve();
        this.snapshotsRestored = 0;
        this.stamper = new KeyStamper(context.model.cyclesPerSecond);
        // Set while this machine orders the session's inputs, having taken control; the cycle it is to take it at,
        // once its replay has reached it; and the session clock's base, which it then keeps.
        this.sequencer = null;
        this.handoverAt = null;
        this.rtcBaseMs = undefined;
        // Keys the host passes on between handing this machine control and its reaching the cycle to take it at.
        this.keysForControl = [];
        this.lastCommitMs = 0;
        this.left = false;
        this.closing = new AbortController();
        this.log = new SessionLog({
            role: "guest",
            room,
            guest: this.id,
            name,
            model: context.model.name,
            version: context.version,
        });
        this.stats = new IntervalStats();
        this.stopWatchingPage = context.page.watch(this.log, () => this.stats);
        this.lastStats = null;
        this.rttMs = undefined;
        this.leftReason = null;
        this.roster = [];
        this.takeOnKey = false;
        this.desyncs = 0;
        this.panel = context.page.panel(this);
        this.showStatus();
    }

    // The host's light is this page's own view of keeping up with it; the guests' are the host's view of each.
    showStatus() {
        const state = peerState({
            connected: this.lockstep !== null,
            left: this.left,
            stats: this.lastStats,
            statsAgeMs: 0,
        });
        const host = {
            label: this.hostName ?? "Host",
            state,
            rttMs: this.rttMs,
            lagMs: this.lastStats?.lagMs,
            leftReason: this.leftReason,
            control: !this.left && !this.sequencer && !this.roster.some((guest) => guest.control),
        };
        const guests = this.left
            ? []
            : this.roster.map((guest) => (guest.you ? { ...guest, label: `${guest.label} (you)` } : guest));
        const summary = this.left ? "left" : this.lastStats ? `${this.lastStats.lagMs} ms behind` : "joining";
        this.panel.show("guest", summary, [host, ...guests]);
        const inControl = this.roster.find((guest) => guest.control);
        const controller = this.sequencer || inControl?.you ? "you" : (inControl?.label ?? null);
        const canTake = !this.sequencer && this.handoverAt === null && !this.left;
        this.panel.showControl(this.left ? null : (controller ?? this.hostName ?? "the host"), canTake);
    }

    async start() {
        noteStage(this.log.details.role, "created");
        try {
            await this.join();
        } catch (error) {
            this.leave();
            throw error;
        }
    }

    async join() {
        const { processor, loop, keyboard, transport, page } = this.context;
        // Nothing runs until the host's snapshot arrives, and a paste or autoboot of this
        // page's own would only be thrown away by it.
        keyboard.cancelPaste();
        loop.setLockstep({ execute: () => true });
        holdAnalogue(processor, true);
        page.onPageHide(() => {
            if (this.left) return;
            this.send({ type: "bye" });
            noteStage(this.log.details.role, "ended", { reason: SessionFailures.pageClosed });
        }, this.closing.signal);
        page.notify(`Joining "${this.room}"...`);
        this.link = await transport.join(this.room, this.id, {
            offered: () => this.log.record("offer"),
            answered: () => this.log.record("answer"),
            message: (data) => this.fromHost(data),
            closed: () => this.hostLeft(),
        });
        this.log.record("connected");
        noteStage(this.log.details.role, "connected");
        this.send({ type: "hello", name: this.name });
        keyboard.setInput(sessionInput(processor.sysvia, (input) => this.input(input), { allowBreak: false }));
    }

    // Sent with this page's time, so the host's log shows how long each key was really held, and the cycle it is
    // to go in at, so it keeps its place among the others however the network bunches them.
    input(input) {
        // At once, as on a machine of its own, unless its keys are catching up after taking control: then keeping
        // their gaps from the last, so none is cut short.
        if (this.sequencer) {
            const now = { cycle: cycleCount(this.context.processor), nowMs: this.log.elapsed() };
            const behind = this.stamper.catchingUp || this.sequencer.waiting(this.id);
            if (!behind) this.stamper.mark(now);
            this.sequencer.queue(this.id, input, {}, behind ? this.stamper.follow(now) : undefined);
            this.send({ type: "input", input, own: true });
            return;
        }
        const at = this.stamp();
        this.log.record("input", { ...input, at });
        const take = input.down && this.takeOnKey;
        this.send({ type: "input", input, ms: this.log.elapsed(), at, snapshots: this.snapshotsRestored, take });
    }

    requestControl() {
        if (!this.sequencer) this.send({ type: "take" });
    }

    // Undefined before there is a machine to stamp against.
    stamp() {
        if (!this.lockstep) return undefined;
        const nowMs = this.log.elapsed();
        const { upTo } = this.lockstep;
        // A guest in control is a further round trip away, through the host.
        const controllerRttMs = this.roster.find((guest) => guest.control && !guest.you)?.rttMs ?? 0;
        const roundTripMs = (this.rttMs ?? UnmeasuredRttMs) + controllerRttMs;
        const stamp = this.stamper.stamp({ upTo, roundTripMs, sinceCommitMs: nowMs - this.lastCommitMs, nowMs });
        const cyclesPerMs = this.context.processor.model.cyclesPerSecond / 1000;
        this.stats.peak("stampAheadMs", Math.round((stamp - upTo) / cyclesPerMs));
        return stamp;
    }

    // Starved: the guest has caught the host up and waits on its next commit. Catching up: far enough behind
    // that it runs more than its slice, as LockstepGuest.replay decides.
    execute(cycles) {
        if (this.sequencer) return this.executeInControl(cycles);
        const { processor } = this.context;
        const { lockstep, stats } = this;
        const cyclesPerMs = processor.model.cyclesPerSecond / 1000;
        const catchingUp = lockstep.behind() - MaxGuestLagSeconds * 1000 * cyclesPerMs > cycles;
        const before = cycleCount(processor);
        const running = lockstep.execute(cycles);
        const ran = cycleCount(processor) - before;
        const lagMs = lockstep.behind() / cyclesPerMs;
        stats.tick("frames");
        if (this.context.page.hidden()) stats.count("hiddenFrames");
        if (catchingUp) stats.count("catchingUp");
        else if (lockstep.behind() === 0 && ran < cycles) stats.count("starved");
        stats.peak("maxLagMs", Math.round(lagMs));
        if (this.handoverAt === cycleCount(processor) && lockstep.behind() === 0) this.takeControl();
        this.summarise(Math.round(lagMs));
        return running;
    }

    // Ordering the inputs, as the host does: it never runs behind anyone.
    executeInControl(cycles) {
        const running = this.sequencer.execute(cycles);
        this.stats.tick("frames");
        if (this.context.page.hidden()) this.stats.count("hiddenFrames");
        this.summarise(0);
        return running;
    }

    takeControl() {
        const { processor } = this.context;
        this.handoverAt = null;
        this.sequencer = new Sequencer(processor, {
            log: this.log,
            stats: () => this.stats,
            send: (commit) => {
                this.stats.tick("commits");
                this.send(commit);
            },
            // The host sees the next commit not follow on, takes control back and starts everyone afresh.
            onJump: () => {},
            rtcBaseMs: this.rtcBaseMs,
        });
        for (const { source, input, at } of this.keysForControl.splice(0))
            this.sequencer.queue(source, input, { from: source }, at);
        this.log.record("control", { at: cycleCount(processor) });
        this.context.page.notify("You have control.");
        this.showStatus();
    }

    // Stops between two executes, at the end of its last commit, and hands back the keys it had not applied yet; or,
    // asked before it has taken control, gives it up at the cycle it was to take it at.
    release() {
        if (this.handoverAt !== null) {
            const at = this.handoverAt;
            this.handoverAt = null;
            this.log.record("released", { at });
            this.send({ type: "released", at, waiting: this.keysForControl.splice(0) });
            this.showStatus();
            return;
        }
        if (!this.sequencer) return;
        const at = cycleCount(this.context.processor);
        const waiting = this.sequencer.releaseAll();
        this.sequencer = null;
        this.lockstep.resync();
        this.stamper.reset();
        this.log.record("released", { at });
        this.send({ type: "released", at, waiting });
        this.showStatus();
    }

    summarise(lagMs) {
        const { stats } = this;
        const summary = stats.take();
        if (summary) {
            summary.lagMs = lagMs;
            summary.commits = summary.commits ?? 0;
            this.log.record("stats", summary);
            this.send({ type: "stats", stats: summary });
            this.lastStats = summary;
            this.showStatus();
            this.link.stats().then(
                (connection) => {
                    this.rttMs = connection.rttMs;
                    this.log.record("connection", connection);
                },
                () => {},
            );
        }
    }

    send(message) {
        if (this.link?.isOpen()) this.link.send(JSON.stringify(message));
    }

    fromHost(data) {
        if (this.left) return;
        if (typeof data !== "string") {
            this.receiveChunk(new Uint8Array(data));
            return;
        }
        const message = parsed(data);
        if (!message) {
            this.fail(SessionFailures.protocol, "the host sent something this page cannot read");
            return;
        }
        switch (message.type) {
            case "welcome":
                this.welcome(message);
                break;
            case "snapshot":
                if (!Number.isInteger(message.bytes) || message.bytes <= 0 || message.bytes > MaxSnapshotBytes) {
                    this.fail(SessionFailures.protocol, "the host sent a snapshot of an impossible size");
                    return;
                }
                // A snapshot from the host makes this machine a replayer again, whatever it was doing; one that was
                // in control waits for it from where it is, with nothing to replay.
                if (this.sequencer) this.lockstep.resync();
                this.sequencer = null;
                this.handoverAt = null;
                this.keysForControl = [];
                this.incoming = { bytes: new Uint8Array(message.bytes), received: 0, commits: [] };
                break;
            case "commit":
                this.receiveCommit(message);
                break;
            case "roster":
                this.roster = cleanRoster(message.guests);
                this.takeOnKey = message.takeOnKey === true;
                this.panel.showTakeOnKey(this.takeOnKey);
                this.showStatus();
                break;
            case "handover":
                if (Number.isSafeInteger(message.at)) this.handoverAt = message.at;
                break;
            case "release":
                this.release();
                break;
            case "input": {
                // Someone else's key, passed on by the host for this machine to apply while it is in control.
                const key = checkedKey(message);
                if (key && this.sequencer) this.sequencer.queue(key.source, key.input, { from: key.source }, key.at);
                else if (key && this.handoverAt !== null) this.keysForControl.push(key);
                break;
            }
        }
    }

    // Commits that follow a snapshot wait for it to be restored; snapshots are
    // restored in the order they came, so a second one cannot overtake the first.
    receiveCommit(commit) {
        if (!isValidCommit(commit)) {
            this.fail(SessionFailures.protocol, "the host sent a commit this page cannot read");
            return;
        }
        this.stats.tick("commits");
        this.lastCommitMs = this.log.elapsed();
        if (commit.inputs.length > 0) {
            // Rebuilt from the checked fields, so nothing else the host put in them is kept.
            const inputs = commit.inputs.map(({ kind, mapping, down }) => ({ kind, mapping, down }));
            this.log.record("inputs", { cycle: commit.at, inputs });
        }
        const waiting = this.incoming ?? this.buffering;
        if (waiting) waiting.commits.push(commit);
        else this.lockstep?.receive(commit);
    }

    welcome({ model, takenFromHost, version, name }) {
        this.hostName = cleanName(name);
        const field = (value) => String(value).slice(0, MaxReasonLength);
        const hostValues = readTakenFromHost(takenFromHost);
        this.log.record("welcome", {
            model: field(model),
            takenFromHost: hostValues,
            version: field(version),
            name: this.hostName,
        });
        this.showStatus();
        if (typeof model !== "string" || !findModel(model)) {
            this.fail(SessionFailures.protocol, "the host did not say what machine it is");
            return;
        }
        if (version !== this.context.version) {
            this.fail(
                SessionFailures.protocol,
                `the host runs jsbeeb ${version} and this is ${this.context.version}; whoever is older should reload`,
            );
            return;
        }
        if (!hostValues) {
            this.fail(SessionFailures.protocol, "the host's machine has a setting this page cannot take");
            return;
        }
        if (!isSameModel(model, this.context.model.name) || !matchesHost(hostValues, this.context.takenFromHost)) {
            this.send({ type: "bye" });
            this.left = true;
            this.context.page.reloadAs({ model, ...hostValues });
        }
    }

    receiveChunk(chunk) {
        const incoming = this.incoming;
        if (!incoming) return;
        if (incoming.received + chunk.length > incoming.bytes.length) {
            this.fail(SessionFailures.protocol, "the host sent more snapshot than it said it would");
            return;
        }
        incoming.bytes.set(chunk, incoming.received);
        incoming.received += chunk.length;
        if (incoming.received < incoming.bytes.length) return;
        this.incoming = null;
        this.buffering = incoming;
        this.log.record("snapshot", { bytes: incoming.bytes.length });
        this.restored = this.restored
            .then(() => this.restore(incoming))
            .catch((error) =>
                this.fail(SessionFailures.restoreFailed, `restoring the host's machine failed: ${error.message}`),
            );
    }

    async restore(snapshot) {
        const { processor, loop } = this.context;
        const restored = snapshotFromJSON(await this.context.codec.decompress(snapshot.bytes));
        if (this.left) return;
        loop.replacingState();
        restoreSessionSnapshot(processor, restored);
        this.rtcBaseMs = restored.rtcBaseMs;
        ++this.snapshotsRestored;
        this.stamper.reset();
        this.lastCommitMs = this.log.elapsed();
        if (this.lockstep) {
            this.lockstep.resync();
        } else {
            this.lockstep = new LockstepGuest(processor, (reason, dropped, moved, evidence) =>
                this.desynced(reason, evidence),
            );
            // The first summary would otherwise cover the whole of joining.
            this.stats = new IntervalStats();
            loop.setLockstep({ execute: (cycles) => this.execute(cycles) });
            this.context.page.notify(`Joined "${this.room}".`);
            this.showStatus();
            this.panel.open();
        }
        this.log.record("restored", { cycle: cycleCount(processor) });
        if (this.buffering === snapshot) this.buffering = null;
        for (const commit of snapshot.commits) this.lockstep.receive(commit);
    }

    desynced(reason, evidence) {
        this.log.record("desync", { reason, ...evidence });
        this.stats.count("desyncs");
        this.send({ type: "resync", reason });
        announceDesync(this.context.page.notify, ++this.desyncs, "This machine desynced", reason, "the host");
    }

    hostLeft() {
        if (this.left) return;
        this.context.page.notify("Lost the host; the machine carries on here on its own.");
        this.log.record("left", { reason: "lost the host" });
        noteStage(this.log.details.role, "ended", { reason: SessionFailures.hostLeft });
        this.leave("lost the host");
    }

    /** @param {string} code what went wrong, one of `SessionFailures`; `reason` says it in words */
    fail(code, reason) {
        if (this.left) return;
        this.context.page.notify(`Leaving the session: ${reason}.`);
        this.log.record("left", { reason });
        noteStage(this.log.details.role, "failed", { reason: code });
        this.leave(reason);
    }

    leave(reason = "couldn't join") {
        this.left = true;
        this.closing.abort();
        this.sequencer = null;
        this.stopWatchingPage();
        this.leftReason = reason;
        holdAnalogue(this.context.processor, false);
        this.context.processor.sysvia.cmos.leaveSession();
        this.context.loop.setLockstep(null);
        this.context.keyboard.setInput(null);
        this.link?.close();
        this.showStatus();
    }

    report() {
        const { processor } = this.context;
        const inSession = this.lockstep && !this.left;
        const lagMs = inSession ? (this.lockstep.behind() * 1000) / processor.model.cyclesPerSecond : undefined;
        return this.log.report({ lagMs, keysDown: keysDown(processor.sysvia) });
    }
}

const guestName = (guest) => guest.name ?? `Guest ${guest.number}`;

/** A key a guest in control handed back, as `{ source, input, at }`, if it is one. */
function checkedKey(key) {
    if (key?.input?.kind !== "key" || !isValidInput(key.input)) return null;
    const { mapping, down } = key.input;
    return {
        source: String(key.source).slice(0, MaxReasonLength),
        input: { kind: "key", mapping: [...mapping], down },
        at: Number.isSafeInteger(key.at) ? key.at : undefined,
    };
}

const finiteOrUndefined = (value) => (Number.isFinite(value) ? value : undefined);

/** The host's list of guests, as the lights can show it whatever the host sent. */
function cleanRoster(guests) {
    if (!Array.isArray(guests)) return [];
    return guests.slice(0, MaxRosterGuests).map((guest) => ({
        label: cleanName(guest?.label) ?? "Guest",
        state: PeerStates.has(guest?.state) ? guest.state : "silent",
        rttMs: finiteOrUndefined(guest?.rttMs),
        lagMs: finiteOrUndefined(guest?.lagMs),
        leftReason: typeof guest?.leftReason === "string" ? guest.leftReason.slice(0, MaxReasonLength) : undefined,
        you: guest?.you === true,
        control: guest?.control === true,
    }));
}

/**
 * The address that joins `room`, as `name` if one is given, keeping those of `params` that are local to the page, the
 * key and gamepad mappings among them, which a guest applies before its keys are sent.
 */
export function joinLink(room, name, params = {}) {
    const kept = Object.entries(params).filter(([key]) => parameterFor(key)?.parameter.localToPage);
    const { origin, pathname } = window.location;
    return buildUrlFromParams(origin + pathname, { client: room, name, ...Object.fromEntries(kept) }, urlParamType);
}

function parsedUrl(text) {
    try {
        return new URL(text);
    } catch {
        return null;
    }
}

/** The room in `text`, which is a room's name or a link to it (with or without its scheme), or null if neither. */
export function roomFrom(text) {
    const trimmed = text.trim();
    const link = parsedUrl(trimmed) ?? (trimmed.includes("?") ? parsedUrl(`https://${trimmed}`) : null);
    const room = link ? (link.searchParams.get("client") ?? link.searchParams.get("server") ?? "") : trimmed;
    return RoomName.test(room) ? room : null;
}

/** Why this machine cannot host or join a session, or null if it can. */
export function sessionRefusal({ model, processor }) {
    if (model.isAtom || processor.hasTube)
        return "Shared sessions need a BBC Model B or Master, without a second processor.";
    return null;
}

/**
 * What the rendezvous's refusals mean to a host, which only ever makes its room, and to a guest, which looks for one:
 * a `code` for analytics and the `words` for the user.
 */
function startFailure(error, room, host) {
    if (host) {
        if (error.status === RoomGone)
            return {
                code: SessionFailures.serviceUnavailable,
                words: "the shared session service isn't available here",
            };
        if (error.status === RoomTaken)
            return { code: SessionFailures.roomTaken, words: `a room called "${room}" is already open` };
    } else {
        if (error.status === RoomGone)
            return {
                code: SessionFailures.noRoom,
                words: `there's no room called "${room}"; check its name, or the host's page may have closed`,
            };
        if (error.status === TooManyOffers)
            return {
                code: SessionFailures.tooManyJoining,
                words: "too many people are joining at once; try again in a moment",
            };
        if (error.status === RoomTaken)
            return {
                code: SessionFailures.alreadyWaiting,
                words: "this page is already waiting to join; reload it to try again",
            };
    }
    return { code: error.sessionFailure ?? SessionFailures.other, words: error.message };
}

function refused(notify, refusal, host) {
    notify(refusal);
    noteStage(host ? "host" : "guest", "failed", { reason: SessionFailures.unsupportedMachine });
}

function failedToStart(notify, error, room, host) {
    const { code, words } = startFailure(error, room, host);
    notify(`The session couldn't start: ${words}.`);
    noteStage(host ? "host" : "guest", "failed", { reason: code });
    console.error(error);
}

/**
 * Hosts `room`, or joins it as a guest, on this page's machine.
 * @param {SessionContext} context
 * @returns {SessionHost|SessionGuest|null} the session, or null if this machine cannot take part in one
 */
function startSession(context, { host, room, name, secret }) {
    const refusal = sessionRefusal(context);
    if (refusal) {
        refused(context.page.notify, refusal, host);
        return null;
    }
    const cleanedName = cleanName(name) ?? randomName();
    const session = host ? new SessionHost(context, room, cleanedName) : new SessionGuest(context, room, cleanedName);
    session.start(secret).catch((error) => failedToStart(context.page.notify, error, room, host));
    return session;
}

/**
 * Hosts a room with a name of its own on the machine as it is. The room is made first, so a page that could not
 * make one is left as it was, with nothing of a session about it.
 * @param {SessionContext} context
 * @returns {Promise<SessionHost|null>} the session, or null if there is none
 */
export async function hostSession(context, name) {
    const refusal = sessionRefusal(context);
    if (refusal) {
        refused(context.page.notify, refusal, true);
        return null;
    }
    for (let tries = 1; ; ++tries) {
        const room = randomName();
        try {
            const secret = await context.transport.createRoom(room);
            return startSession(context, { host: true, room, name, secret });
        } catch (error) {
            if (error.status === RoomTaken && tries < MaxRoomNameTries) continue;
            failedToStart(context.page.notify, error, room, true);
            return null;
        }
    }
}

/**
 * Starts the session the URL asks for, if any.
 * @param {SessionContext} context
 * @returns {SessionHost|SessionGuest|null}
 */
export function startSessionFromUrl(params, context) {
    if (!params.server && !params.client) return null;
    return startSession(context, { host: !!params.server, room: params.server || params.client, name: params.name });
}
