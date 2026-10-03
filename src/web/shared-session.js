// A shared session in the browser: the host's machine runs as usual and its
// inputs and cycles stream to guests over WebRTC data channels, which the
// rendezvous only helps to open. `?server=<room>` hosts and `?client=<room>`
// joins. See docs/shared-sessions-design.md for the protocol and its limits.

import { humanId } from "human-id";

import {
    cycleCount,
    isValidCommit,
    isValidInput,
    LockstepGuest,
    LockstepHost,
    MaxGuestLagSeconds,
    restoreSessionSnapshot,
} from "../lockstep.js";
import { AdcCentreValue } from "../adc.js";
import { findModel } from "../models.js";
import { isSameModel, snapshotFromJSON, snapshotToJSON } from "../snapshot.js";
import { reloadAsMachine } from "./machine-switch.js";
import {
    connectionStats,
    IntervalStats,
    numbersFrom,
    rounded,
    SessionLog,
    StatsIntervalMs,
    watchPage,
} from "./session-log.js";
import { PeerStates, peerState, SessionPanel } from "./session-panel.js";
import { downloadBlob } from "./dom-utils.js";
import { toast } from "./toast.js";

const IceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const IceGatheringTimeoutMs = 3000;
const HostPollMs = 1500;
const GuestPollMs = 1000;
const PasteWaitMs = 500;
export const AnswerTimeoutMs = 30000;
export const ConnectTimeoutMs = 20000;
export const MinResyncIntervalMs = 2000;
// Offers anyone who knows the room's name can post; this bounds the connections in progress at once.
export const MaxConnectingGuests = 4;
const SnapshotChunkBytes = 16 * 1024;
const MaxSnapshotBytes = 64 * 1024 * 1024;
const ToastTitle = "Shared session";
const RoomGone = 404;
// A key stamped further ahead of the host than this is applied at once; an honest guest's round trip and the
// pause since the host's last commit come nowhere near it.
const MaxStampAheadSeconds = 2;
// A guest with more keys than this waiting for their cycles has them all applied at once instead.
const MaxWaitingKeys = 64;
// A guest stamps its keys with a round trip it has not measured yet as this, and allows this much on top for
// the trip taking longer than it did.
const UnmeasuredRttMs = 200;
const JitterMarginMs = 20;
// Commits come every few milliseconds from a host running in real time; one that has gone quiet for longer is
// running slowly (hidden, say), and counting the whole pause would stamp keys far beyond where it will be.
const MaxSinceCommitMs = 100;
// While keys are catching up, on a guest stamping later than it would or on a host applying them later than
// stamped, a gap between two keys longer than this shrinks to it: four of the OS's 10 ms keyboard scans, so each
// key is still seen, while keys pressed closer together stay as close.
const CatchUpGapMs = 40;

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
];
// A guest sends a summary each StatsIntervalMs; more often than this, the rest are dropped.
const MinGuestStatsIntervalMs = StatsIntervalMs / 2;
// Far more guests than a session can hold, so a hostile host cannot flood a guest's lights.
const MaxRosterGuests = 16;
// A guest that has left keeps its light this long, so a drop is seen even by someone who looked away.
const LeftShownMs = 30000;

/**
 * When the next of a run of keys goes, `at` and no earlier than `earliest`, after the last went at `last.went`
 * `gap` before: as far after it as it was, but with a gap over `catchUp` shortened to it, so a run that has
 * fallen behind its own times makes the lag up a little with each key.
 */
function nextInRun(at, earliest, last, gap, catchUp) {
    const after = last ? last.went + Math.min(gap, catchUp) : -Infinity;
    return Math.max(at, earliest, after, last?.went ?? -Infinity);
}

function notify(message) {
    console.log(`Shared session: ${message}`);
    toast(message, { title: ToastTitle });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The rendezvous carries one offer and one answer per guest, so each side waits
// for its candidates before sending its description rather than trickling them.
async function gatheredDescription(pc) {
    if (pc.iceGatheringState !== "complete") {
        await Promise.race([
            new Promise((resolve) =>
                pc.addEventListener("icegatheringstatechange", () => {
                    if (pc.iceGatheringState === "complete") resolve();
                }),
            ),
            delay(IceGatheringTimeoutMs),
        ]);
    }
    return pc.localDescription.sdp;
}

function opened(channel) {
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("couldn't connect directly")), ConnectTimeoutMs);
        channel.addEventListener("open", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function gzip(text) {
    const stream = new Response(text).body.pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
    return new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"))).text();
}

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
 * person's layout, and handed to `send` as session inputs. BREAK goes too only
 * if `allowBreak`.
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
 * @property {import("./emulation-loop.js").EmulationLoop} loop
 * @property {import("./keyboard.js").Keyboard} keyboard
 * @property {import("./url-state.js").UrlState} urlState
 * @property {string} version
 * @property {ReturnType<typeof import("./rendezvous-client.js").createRendezvousClient>} rendezvous
 */

export class SessionHost {
    constructor(context, room, name = randomName()) {
        this.context = context;
        this.room = room;
        this.name = name;
        this.guests = new Map();
        this.offersSeen = new Set();
        this.secret = null;
        this.polling = true;
        this.closed = false;
        this.log = new SessionLog({ role: "host", room, name, model: context.model.name, version: context.version });
        this.stats = new IntervalStats();
        this.guestsSeen = 0;
        this.departed = [];
        this.panel = new SessionPanel(sessionPane(this));
    }

    async start() {
        const { processor, loop, keyboard, rendezvous } = this.context;
        while (keyboard.isPasting) await delay(PasteWaitMs);
        this.secret = await rendezvous.createRoom(this.room);
        this.lockstep = new LockstepHost(
            processor,
            (commit) => this.broadcast(JSON.stringify(commit)),
            () => this.resyncEveryone(),
        );
        this.reachedAt = cycleCount(processor);
        loop.setLockstep({ execute: (cycles) => this.execute(cycles) });
        keyboard.setInput(sessionInput(processor.sysvia, (input) => this.input(input), { allowBreak: true }));
        holdAnalogue(processor, true);
        window.addEventListener("pagehide", () => this.close());
        notify(`Hosting "${this.room}". Guests join at ${joinLink(this.room)}`);
        this.panel.open();
        this.log.record("hosting");
        this.stopWatchingPage = watchPage(this.log, () => this.stats);
        this.poll();
    }

    // Logged with the cycle it is applied at: the machine is between two of the lockstep's executes.
    input(input, fields = {}) {
        this.log.record("input", { ...fields, ...input, cycle: cycleCount(this.context.processor) });
        this.lockstep.input(input);
    }

    // While keys are waiting, the cycles asked for run in pieces that end where the next is due, each its
    // own commit, so a long execute cannot bring keys spaced apart back onto one cycle. The pieces add up
    // to what was asked, so the processor's overshoot carries over as it does in one execute.
    execute(cycles) {
        const { processor } = this.context;
        this.followJump();
        let remaining = cycles;
        let running;
        for (;;) {
            const now = cycleCount(processor);
            let nextAt = Infinity;
            for (const guest of this.guests.values()) {
                while (guest.scheduled.length > 0 && guest.scheduled[0].at <= now) {
                    const { input, fields } = guest.scheduled.shift();
                    this.input(input, fields);
                }
                if (guest.scheduled.length > 0) nextAt = Math.min(nextAt, guest.scheduled[0].at);
            }
            const piece = Math.min(remaining, nextAt - now);
            running = this.lockstep.execute(piece);
            this.reachedAt = cycleCount(processor);
            remaining -= piece;
            if (!running || remaining <= 0) break;
        }
        this.stats.tick("frames");
        if (document.hidden) this.stats.count("hiddenFrames");
        const summary = this.stats.take();
        if (summary) {
            this.log.record("stats", summary);
            for (const guest of this.guests.values()) {
                if (!guest.welcomed) continue;
                connectionStats(guest.pc).then(
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
        this.panel.show(
            "hosting",
            `${count} ${count === 1 ? "guest" : "guests"}`,
            views.map(([, view]) => view),
        );
        for (const guest of [...this.guests.values()]) {
            if (!guest.welcomed) continue;
            const guests = views.map(([each, view]) => (each === guest ? { ...view, you: true } : view));
            this.sendTo(guest, JSON.stringify({ type: "roster", guests }));
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
        return { label: guest.name ?? `Guest ${guest.number}`, state, rttMs, lagMs: guest.stats?.lagMs, leftReason };
    }

    // The machine only moves between executes by jumping (a reset, a loaded state), and the keys still
    // waiting, due on the old cycle count, move with it.
    followJump() {
        const jump = cycleCount(this.context.processor) - this.reachedAt;
        if (jump === 0) return;
        this.reachedAt += jump;
        for (const guest of this.guests.values()) for (const key of guest.scheduled) key.at += jump;
    }

    /**
     * Applies a guest's key at the cycle `at` it was stamped with, if it was stamped after the guest's latest
     * snapshot (`snapshots` is how many it had restored); otherwise at once. A key too late for its cycle goes in
     * as soon as it can, and the ones after it keep their gaps from it, as nextInRun says, so a bunch held up past
     * its cycles goes in as far apart as it was typed and the lag is made up over the keys that follow.
     */
    queueKey(guest, input, fields, { at, snapshots }) {
        this.followJump();
        const { processor } = this.context;
        const now = cycleCount(processor);
        const cyclesPerMs = processor.model.cyclesPerSecond / 1000;
        const stamped =
            at !== undefined &&
            snapshots === guest.snapshotsSent &&
            at <= now + MaxStampAheadSeconds * 1000 * cyclesPerMs;
        let due = Math.max(now, guest.scheduled.at(-1)?.at ?? now);
        if (stamped) {
            if (at < now) {
                this.stats.count("lateKeys");
                this.stats.peak("lateKeyMaxMs", rounded((now - at) / cyclesPerMs));
            }
            const last = guest.lastKey;
            due = nextInRun(at, due, last && { went: last.due }, last ? at - last.at : 0, CatchUpGapMs * cyclesPerMs);
            guest.lastKey = { at, due };
        } else {
            guest.lastKey = null;
        }
        if (due === now && guest.scheduled.length === 0) {
            this.input(input, fields);
            return;
        }
        guest.scheduled.push({ input, at: due, fields: { ...fields, arrivedMs: this.log.elapsed() } });
        if (guest.scheduled.length > MaxWaitingKeys) {
            for (const key of guest.scheduled.splice(0)) this.input(key.input, key.fields);
            guest.lastKey = null;
        }
    }

    async poll() {
        while (this.polling) {
            try {
                const offers = await this.context.rendezvous.listOffers(this.room, this.secret);
                if (!this.polling) return;
                // Each offer is answered once: one whose answer failed would otherwise be retried every poll.
                for (const offer of offers) {
                    if (!this.offersSeen.has(offer.guest) && this.connectingCount() < MaxConnectingGuests) {
                        this.offersSeen.add(offer.guest);
                        this.answer(offer);
                    }
                }
            } catch (error) {
                if (error.status === RoomGone) {
                    await this.reopenRoom();
                } else {
                    console.warn(`Shared session: polling the rendezvous failed: ${error.message}`);
                }
            }
            await delay(HostPollMs);
        }
    }

    // A host that slept, or a dev server that restarted, finds its room gone; nobody
    // could join it again until it is made afresh.
    async reopenRoom() {
        try {
            this.secret = await this.context.rendezvous.createRoom(this.room);
            notify(`The room "${this.room}" had expired, and is open again.`);
            this.log.record("room reopened");
        } catch (error) {
            notify(`The room "${this.room}" has gone, so nobody else can join: ${error.message}`);
            this.log.record("room gone", { reason: error.message });
            this.polling = false;
        }
    }

    connectingCount() {
        return [...this.guests.values()].filter((guest) => guest.channel?.readyState !== "open").length;
    }

    connectedCount() {
        return this.guests.size - this.connectingCount();
    }

    async answer({ guest: id, sdp }) {
        const pc = new RTCPeerConnection({ iceServers: IceServers });
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
            pc,
            channel: null,
            ready: false,
            backlog: [],
            held: new Map(),
            // Keys waiting for the cycle queueKey gave them, in the order they came.
            scheduled: [],
            // Snapshots sent in full, which the guest counts as it restores them; a key stamped before the
            // latest belongs to a machine that has since been replaced.
            snapshotsSent: 0,
            // The stamp and the cycle due of its last stamped key, which the next keeps its gap from.
            lastKey: null,
            lastSnapshotMs: 0,
            snapshotGeneration: 0,
            resyncTimer: null,
        };
        this.guests.set(id, guest);
        this.log.record("offer", { guest: id });
        this.showStatus();
        // A guest has one channel; another would cost the host a snapshot each.
        pc.addEventListener("datachannel", ({ channel }) => {
            if (!guest.channel) this.adopt(guest, channel);
        });
        setTimeout(() => {
            if (!guest.channel) this.drop(guest, "it never opened a channel");
        }, ConnectTimeoutMs);
        try {
            await pc.setRemoteDescription({ type: "offer", sdp });
            await pc.setLocalDescription(await pc.createAnswer());
            await this.context.rendezvous.postAnswer(this.room, this.secret, id, await gatheredDescription(pc));
        } catch (error) {
            console.warn(`Shared session: answering ${id} failed: ${error.message}`);
            this.drop(guest, `answering it failed: ${error.message}`);
        }
    }

    adopt(guest, channel) {
        guest.channel = channel;
        channel.binaryType = "arraybuffer";
        channel.addEventListener("close", () => this.drop(guest, "its channel closed"));
        channel.addEventListener("message", ({ data }) => this.fromGuest(guest, data));
        opened(channel).then(
            () => {
                const { model, version } = this.context;
                const welcome = { type: "welcome", model: model.name, version, name: this.name };
                if (!this.sendTo(guest, JSON.stringify(welcome))) return;
                guest.welcomed = true;
                this.sendSnapshot(guest);
                notify(`A guest joined (${this.connectedCount()} connected).`);
                this.log.record("joined", { guest: guest.id });
                this.showStatus();
            },
            () => this.drop(guest, "its channel never opened"),
        );
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
            this.showStatus();
        } else if (message.type === "stats" && this.log.elapsed() - guest.statsMs < MinGuestStatsIntervalMs) {
            ++guest.statsDropped;
        } else if (message.type === "stats") {
            guest.stats = numbersFrom(message.stats, GuestStatsKeys);
            guest.statsMs = this.log.elapsed();
            this.log.record("guest stats", { ...guest.stats, guest: guest.id, dropped: guest.statsDropped });
            guest.statsDropped = 0;
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
            if (guest.channel) this.sendSnapshot(guest);
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
        guest.backlog = [];
        guest.lastSnapshotMs = Date.now();
        const startMs = this.log.elapsed();
        const json = snapshotToJSON(this.lockstep.snapshot());
        const takeMs = rounded(this.log.elapsed() - startMs);
        const bytes = await gzip(json);
        if (generation !== guest.snapshotGeneration) return;
        const tookMs = rounded(this.log.elapsed() - startMs);
        this.log.record("snapshot", { guest: guest.id, bytes: bytes.length, takeMs, tookMs });
        if (!this.sendTo(guest, JSON.stringify({ type: "snapshot", bytes: bytes.length }))) return;
        for (let offset = 0; offset < bytes.length; offset += SnapshotChunkBytes) {
            if (!this.sendTo(guest, bytes.slice(offset, offset + SnapshotChunkBytes))) return;
        }
        ++guest.snapshotsSent;
        guest.lastKey = null;
        for (const commit of guest.backlog) {
            if (!this.sendTo(guest, commit)) return;
        }
        guest.backlog = [];
        guest.ready = true;
    }

    /** Sends, or drops a guest whose channel has gone or whose send buffer is full. */
    sendTo(guest, data) {
        try {
            if (guest.channel?.readyState !== "open") throw new Error("the channel is not open");
            guest.channel.send(data);
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
            else if (guest.channel) guest.backlog.push(commit);
        }
    }

    // Every key the guest is holding, or whose release is still waiting, is let go, or it would stay down.
    releaseKeys(guest) {
        const releases = new Map(guest.held);
        for (const { input } of guest.scheduled.splice(0)) releases.set(mappingKey(input.mapping), input.mapping);
        for (const mapping of releases.values()) this.input({ kind: "key", mapping, down: false }, { guest: guest.id });
    }

    drop(guest, reason) {
        if (this.guests.get(guest.id) !== guest) return;
        this.guests.delete(guest.id);
        this.log.record("left", { guest: guest.id, reason });
        guest.leftMs = this.log.elapsed();
        guest.leftReason = reason;
        this.departed.push(guest);
        this.showStatus();
        clearTimeout(guest.resyncTimer);
        this.releaseKeys(guest);
        guest.pc.close();
        if (guest.welcomed) notify(`${guest.name ?? "A guest"} left (${this.connectedCount()} connected).`);
    }

    // A page kept for the back button comes back as an ordinary one. The keys let go
    // as the keyboard leaves the session, BREAK among them, are applied before the loop does.
    close() {
        if (this.closed) return;
        this.closed = true;
        this.polling = false;
        this.stopWatchingPage?.();
        const { processor, loop, keyboard } = this.context;
        keyboard.setInput(null);
        for (const guest of this.guests.values()) this.releaseKeys(guest);
        this.lockstep.execute(0);
        loop.setLockstep(null);
        for (const guest of this.guests.values()) {
            clearTimeout(guest.resyncTimer);
            guest.pc.close();
        }
        this.context.rendezvous.deleteRoom(this.room, this.secret).catch(() => {});
        holdAnalogue(processor, false);
        processor.sysvia.cmos.leaveSession();
        this.log.record("closed");
    }

    report() {
        return this.log.report({
            keysDown: keysDown(this.context.processor.sysvia),
            guests: [...this.guests.values()].map((guest) => ({
                id: guest.id,
                connected: guest.channel?.readyState === "open",
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
        this.pc = null;
        this.channel = null;
        this.lockstep = null;
        this.incoming = null;
        this.buffering = null;
        this.restored = Promise.resolve();
        this.snapshotsRestored = 0;
        this.lastStamp = null;
        this.lastCommitMs = 0;
        this.left = false;
        this.log = new SessionLog({
            role: "guest",
            room,
            guest: this.id,
            name,
            model: context.model.name,
            version: context.version,
        });
        this.stats = new IntervalStats();
        this.stopWatchingPage = watchPage(this.log, () => this.stats);
        this.lastStats = null;
        this.rttMs = undefined;
        this.leftReason = null;
        this.roster = [];
        this.panel = new SessionPanel(sessionPane(this));
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
        };
        const guests = this.left
            ? []
            : this.roster.map((guest) => (guest.you ? { ...guest, label: `${guest.label} (you)` } : guest));
        const summary = this.left ? "left" : this.lastStats ? `${this.lastStats.lagMs} ms behind` : "joining";
        this.panel.show("guest", summary, [host, ...guests]);
    }

    async start() {
        try {
            await this.join();
        } catch (error) {
            this.leave();
            throw error;
        }
    }

    async join() {
        const { processor, loop, keyboard, rendezvous } = this.context;
        // Nothing runs until the host's snapshot arrives, and a paste or autoboot of this
        // page's own would only be thrown away by it.
        keyboard.cancelPaste();
        loop.setLockstep({ execute: () => true });
        holdAnalogue(processor, true);
        const pc = (this.pc = new RTCPeerConnection({ iceServers: IceServers }));
        const channel = (this.channel = pc.createDataChannel("session", { ordered: true }));
        channel.binaryType = "arraybuffer";
        channel.addEventListener("message", ({ data }) => this.fromHost(data));
        channel.addEventListener("close", () => this.hostLeft());
        window.addEventListener("pagehide", () => this.send({ type: "bye" }));
        await pc.setLocalDescription(await pc.createOffer());
        notify(`Joining "${this.room}"...`);
        await rendezvous.postOffer(this.room, this.id, await gatheredDescription(pc));
        this.log.record("offer");
        const answer = await this.awaitAnswer();
        this.log.record("answer");
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        await opened(channel);
        this.log.record("connected");
        this.send({ type: "hello", name: this.name });
        keyboard.setInput(sessionInput(processor.sysvia, (input) => this.input(input), { allowBreak: false }));
    }

    // Sent with this page's time, so the host's log shows how long each key was really held, and the cycle it is
    // to go in at, so it keeps its place among the others however the network bunches them.
    input(input) {
        const at = this.stamp();
        this.log.record("input", { ...input, at });
        this.send({ type: "input", input, ms: this.log.elapsed(), at, snapshots: this.snapshotsRestored });
    }

    // A cycle the host will not have passed when the key reaches it. The host was at the end of the last commit
    // when it sent it, has run on since it came, and runs on for the trip back. When the round trip shrinks, the
    // stamps come down to it as nextInRun says, never going backwards and never squeezing keys pressed close
    // together. Undefined before there is a machine to stamp against.
    stamp() {
        if (!this.lockstep) return undefined;
        const nowMs = this.log.elapsed();
        const sinceCommitMs = Math.min(nowMs - this.lastCommitMs, MaxSinceCommitMs);
        const aheadMs = (this.rttMs ?? UnmeasuredRttMs) + sinceCommitMs + JitterMarginMs;
        const cyclesPerMs = this.context.processor.model.cyclesPerSecond / 1000;
        const at = this.lockstep.upTo + Math.round(aheadMs * cyclesPerMs);
        const last = this.lastStamp;
        const gap = last ? Math.round((nowMs - last.ms) * cyclesPerMs) : 0;
        const stamp = nextInRun(at, -Infinity, last && { went: last.at }, gap, CatchUpGapMs * cyclesPerMs);
        this.lastStamp = { at: stamp, ms: nowMs };
        this.stats.peak("stampAheadMs", Math.round((stamp - this.lockstep.upTo) / cyclesPerMs));
        return stamp;
    }

    // Starved: the guest has caught the host up and waits on its next commit. Catching up: far enough behind
    // that it runs more than its slice, as LockstepGuest.replay decides.
    execute(cycles) {
        const { processor } = this.context;
        const { lockstep, stats } = this;
        const cyclesPerMs = processor.model.cyclesPerSecond / 1000;
        const catchingUp = lockstep.behind() - MaxGuestLagSeconds * 1000 * cyclesPerMs > cycles;
        const before = cycleCount(processor);
        const running = lockstep.execute(cycles);
        const ran = cycleCount(processor) - before;
        const lagMs = lockstep.behind() / cyclesPerMs;
        stats.tick("frames");
        if (document.hidden) stats.count("hiddenFrames");
        if (catchingUp) stats.count("catchingUp");
        else if (lockstep.behind() === 0 && ran < cycles) stats.count("starved");
        stats.peak("maxLagMs", Math.round(lagMs));
        const summary = stats.take();
        if (summary) {
            summary.lagMs = Math.round(lagMs);
            summary.commits = summary.commits ?? 0;
            this.log.record("stats", summary);
            this.send({ type: "stats", stats: summary });
            this.lastStats = summary;
            this.showStatus();
            connectionStats(this.pc).then(
                (connection) => {
                    this.rttMs = connection.rttMs;
                    this.log.record("connection", connection);
                },
                () => {},
            );
        }
        return running;
    }

    async awaitAnswer() {
        const deadline = Date.now() + AnswerTimeoutMs;
        while (Date.now() < deadline) {
            const answer = await this.context.rendezvous.getAnswer(this.room, this.id);
            if (answer) return answer;
            await delay(GuestPollMs);
        }
        throw new Error("the host isn't answering");
    }

    send(message) {
        if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(message));
    }

    fromHost(data) {
        if (this.left) return;
        if (typeof data !== "string") {
            this.receiveChunk(new Uint8Array(data));
            return;
        }
        const message = parsed(data);
        if (!message) {
            this.fail("the host sent something this page cannot read");
            return;
        }
        switch (message.type) {
            case "welcome":
                this.welcome(message);
                break;
            case "snapshot":
                if (!Number.isInteger(message.bytes) || message.bytes <= 0 || message.bytes > MaxSnapshotBytes) {
                    this.fail("the host sent a snapshot of an impossible size");
                    return;
                }
                this.incoming = { bytes: new Uint8Array(message.bytes), received: 0, commits: [] };
                break;
            case "commit":
                this.receiveCommit(message);
                break;
            case "roster":
                this.roster = cleanRoster(message.guests);
                this.showStatus();
                break;
        }
    }

    // Commits that follow a snapshot wait for it to be restored; snapshots are
    // restored in the order they came, so a second one cannot overtake the first.
    receiveCommit(commit) {
        if (!isValidCommit(commit)) {
            this.fail("the host sent a commit this page cannot read");
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

    welcome({ model, version, name }) {
        this.hostName = cleanName(name);
        const field = (value) => String(value).slice(0, MaxReasonLength);
        this.log.record("welcome", { model: field(model), version: field(version), name: this.hostName });
        this.showStatus();
        if (typeof model !== "string" || !findModel(model)) {
            this.fail("the host did not say what machine it is");
            return;
        }
        if (version !== this.context.version) {
            this.fail(
                `the host runs jsbeeb ${version} and this is ${this.context.version}; whoever is older should reload`,
            );
            return;
        }
        if (!isSameModel(model, this.context.model.name)) {
            this.send({ type: "bye" });
            this.left = true;
            reloadAsMachine(this.context.urlState, { model }, { replace: true });
        }
    }

    receiveChunk(chunk) {
        const incoming = this.incoming;
        if (!incoming) return;
        if (incoming.received + chunk.length > incoming.bytes.length) {
            this.fail("the host sent more snapshot than it said it would");
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
            .catch((error) => this.fail(`restoring the host's machine failed: ${error.message}`));
    }

    async restore(snapshot) {
        const { processor, loop } = this.context;
        const restored = snapshotFromJSON(await gunzip(snapshot.bytes));
        if (this.left) return;
        // Before the restore, which would cancel the typist's task and leave the keyboard it disabled.
        this.context.keyboard.cancelPaste();
        restoreSessionSnapshot(processor, restored);
        ++this.snapshotsRestored;
        this.lastStamp = null;
        this.lastCommitMs = this.log.elapsed();
        if (this.lockstep) {
            this.lockstep.resync();
        } else {
            this.lockstep = new LockstepGuest(processor, (reason) => this.desynced(reason));
            // The first summary would otherwise cover the whole of joining.
            this.stats = new IntervalStats();
            loop.setLockstep({ execute: (cycles) => this.execute(cycles) });
            notify(`Joined "${this.room}".`);
            this.showStatus();
        }
        this.log.record("restored", { cycle: cycleCount(processor) });
        if (this.buffering === snapshot) this.buffering = null;
        for (const commit of snapshot.commits) this.lockstep.receive(commit);
    }

    desynced(reason) {
        console.warn(`Shared session: ${reason}; asking the host to resync`);
        this.log.record("desync", { reason });
        this.send({ type: "resync", reason });
    }

    hostLeft() {
        if (this.left) return;
        notify("Lost the host; the machine carries on here on its own.");
        this.log.record("left", { reason: "lost the host" });
        this.leave("lost the host");
    }

    fail(reason) {
        if (this.left) return;
        notify(`Leaving the session: ${reason}.`);
        this.log.record("left", { reason });
        this.leave(reason);
    }

    leave(reason = "couldn't join") {
        this.left = true;
        this.stopWatchingPage();
        this.leftReason = reason;
        holdAnalogue(this.context.processor, false);
        this.context.processor.sysvia.cmos.leaveSession();
        this.context.loop.setLockstep(null);
        this.context.keyboard.setInput(null);
        this.pc?.close();
        this.showStatus();
    }

    report() {
        const { processor } = this.context;
        const inSession = this.lockstep && !this.left;
        const lagMs = inSession ? (this.lockstep.behind() * 1000) / processor.model.cyclesPerSecond : undefined;
        return this.log.report({ lagMs, keysDown: keysDown(processor.sysvia) });
    }
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
    }));
}

function joinLink(room) {
    const link = new URL(window.location.href);
    link.search = `?client=${encodeURIComponent(room)}`;
    link.hash = "";
    return link.toString();
}

async function copyJoinLink(room) {
    if (!navigator.clipboard) {
        notify(`Copying needs https. Guests join at ${joinLink(room)}`);
        return;
    }
    try {
        await navigator.clipboard.writeText(joinLink(room));
        toast("The link to join is on the clipboard.", { title: ToastTitle });
    } catch (error) {
        notify(`Couldn't copy the link (${error.message}). Guests join at ${joinLink(room)}`);
    }
}

const sessionPane = (session) => ({
    name: session.name,
    link: joinLink(session.room),
    saveReport: () => saveReport(session),
    copyLink: () => copyJoinLink(session.room),
});

function saveReport(session) {
    const report = session.report();
    const stamp = report.savedAt.replace(/[:.]/g, "-");
    const blob = new Blob([JSON.stringify(report)], { type: "application/json" });
    downloadBlob(blob, `jsbeeb-session-${report.role}-${stamp}.json`);
}

/**
 * Starts the session the URL asks for, if any.
 * @param {SessionContext} context
 */
export function startSessionFromUrl(params, context) {
    if (!params.server && !params.client) return;
    const { model, processor } = context;
    if (model.isAtom || processor.hasTube) {
        notify("Shared sessions need a BBC Model B or Master, without a second processor.");
        return;
    }
    const name = cleanName(params.name) ?? randomName();
    const session = params.server
        ? new SessionHost(context, params.server, name)
        : new SessionGuest(context, params.client, name);
    session.start().catch((error) => {
        notify(`The session couldn't start: ${error.message}`);
        console.error(error);
    });
}
