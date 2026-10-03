// A shared session in the browser: the host's machine runs as usual and its
// inputs and cycles stream to guests over WebRTC data channels, which the
// rendezvous only helps to open. `?server=<room>` hosts and `?client=<room>`
// joins. See docs/shared-sessions-design.md for the protocol and its limits.

import {
    cycleCount,
    isValidCommit,
    isValidInput,
    LockstepGuest,
    LockstepHost,
    restoreSessionSnapshot,
} from "../lockstep.js";
import { AdcCentreValue } from "../adc.js";
import { findModel } from "../models.js";
import { isSameModel, snapshotFromJSON, snapshotToJSON } from "../snapshot.js";
import { reloadAsMachine } from "./machine-switch.js";
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
// A guest's press of a key is applied at least this long after its press of any other, and its release
// this long after the press, so a bunch of taps that reaches the host at once still comes one key at a
// time, each spanning several of the OS's 10ms keyboard scans.
const MinGuestKeySpacingMs = 40;
// A guest with more keys than this waiting for their spacing has them all applied at once instead.
const MaxWaitingKeys = 64;

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
    constructor(context, room) {
        this.context = context;
        this.room = room;
        this.guests = new Map();
        this.offersSeen = new Set();
        this.secret = null;
        this.polling = true;
        this.closed = false;
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
        keyboard.setInput(sessionInput(processor.sysvia, (input) => this.lockstep.input(input), { allowBreak: true }));
        holdAnalogue(processor, true);
        window.addEventListener("pagehide", () => this.close());
        const link = new URL(window.location.href);
        link.search = `?client=${encodeURIComponent(this.room)}`;
        link.hash = "";
        notify(`Hosting "${this.room}". Guests join at ${link}`);
        this.poll();
    }

    // Run in pieces that end where waiting keys are due, so a long execute cannot bring keys spaced
    // apart back onto one cycle.
    execute(cycles) {
        const { processor } = this.context;
        this.followJump();
        const end = cycleCount(processor) + cycles;
        for (;;) {
            const now = cycleCount(processor);
            let nextAt = Infinity;
            for (const guest of this.guests.values()) {
                while (guest.scheduled.length > 0 && guest.scheduled[0].at <= now) {
                    this.lockstep.input(guest.scheduled.shift().input);
                }
                if (guest.scheduled.length > 0) nextAt = Math.min(nextAt, guest.scheduled[0].at);
            }
            const running = this.lockstep.execute(Math.min(end, nextAt) - now);
            this.reachedAt = cycleCount(processor);
            if (!running || this.reachedAt >= end) return running;
        }
    }

    // The machine only moves between executes by jumping (a reset, a loaded state), and the keys still
    // waiting, spaced on the old cycle count, move with it.
    followJump() {
        const jump = cycleCount(this.context.processor) - this.reachedAt;
        if (jump === 0) return;
        this.reachedAt += jump;
        for (const guest of this.guests.values()) {
            for (const key of [...guest.scheduled, ...guest.lastKeys.values()]) key.at += jump;
            guest.lastAt += jump;
            guest.lastPressAt += jump;
        }
    }

    // Spaced as MinGuestKeySpacingMs says, in the order they came. A key is named by its place on the
    // matrix, whatever shift it forces, so the second release keyUp sends goes with the first.
    scheduleKey(guest, input) {
        this.followJump();
        const now = cycleCount(this.context.processor);
        const spacing = this.keySpacingCycles();
        const [col, row] = input.mapping;
        const name = `${col},${row}`;
        const last = guest.lastKeys.get(name);
        let at = Math.max(now, guest.lastAt);
        if (last) at = Math.max(at, last.at + (last.down !== input.down ? spacing : 0));
        if (input.down) at = Math.max(at, guest.lastPressAt + spacing);
        guest.lastKeys.set(name, { at, down: input.down });
        guest.lastAt = at;
        if (input.down) guest.lastPressAt = at;
        if (at === now && guest.scheduled.length === 0) {
            this.lockstep.input(input);
            return;
        }
        guest.scheduled.push({ input, at });
        if (guest.scheduled.length > MaxWaitingKeys) {
            for (const key of guest.scheduled.splice(0)) this.lockstep.input(key.input);
            guest.lastKeys.clear();
            guest.lastAt = now;
            guest.lastPressAt = -Infinity;
        }
    }

    keySpacingCycles() {
        return (MinGuestKeySpacingMs * this.context.processor.model.cyclesPerSecond) / 1000;
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
        } catch (error) {
            notify(`The room "${this.room}" has gone, so nobody else can join: ${error.message}`);
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
            pc,
            channel: null,
            ready: false,
            backlog: [],
            held: new Map(),
            // Keys waiting for the cycle scheduleKey gave them; for each place on the matrix, the cycle
            // and state it was last given; and the cycles of the last key and the last press.
            scheduled: [],
            lastKeys: new Map(),
            lastAt: -Infinity,
            lastPressAt: -Infinity,
            lastSnapshotMs: 0,
            snapshotGeneration: 0,
            resyncTimer: null,
        };
        this.guests.set(id, guest);
        // A guest has one channel; another would cost the host a snapshot each.
        pc.addEventListener("datachannel", ({ channel }) => {
            if (!guest.channel) this.adopt(guest, channel);
        });
        setTimeout(() => {
            if (!guest.channel) this.drop(guest);
        }, ConnectTimeoutMs);
        try {
            await pc.setRemoteDescription({ type: "offer", sdp });
            await pc.setLocalDescription(await pc.createAnswer());
            await this.context.rendezvous.postAnswer(this.room, this.secret, id, await gatheredDescription(pc));
        } catch (error) {
            console.warn(`Shared session: answering ${id} failed: ${error.message}`);
            this.drop(guest);
        }
    }

    adopt(guest, channel) {
        guest.channel = channel;
        channel.binaryType = "arraybuffer";
        channel.addEventListener("close", () => this.drop(guest));
        channel.addEventListener("message", ({ data }) => this.fromGuest(guest, data));
        opened(channel).then(
            () => {
                const { model, version } = this.context;
                if (!this.sendTo(guest, JSON.stringify({ type: "welcome", model: model.name, version }))) return;
                guest.welcomed = true;
                this.sendSnapshot(guest);
                notify(`A guest joined (${this.connectedCount()} connected).`);
            },
            () => this.drop(guest),
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
            this.scheduleKey(guest, { kind: "key", mapping, down });
        } else if (message.type === "bye") {
            this.drop(guest);
        } else if (message.type === "resync") {
            this.requestSnapshot(guest);
        }
    }

    // A guest asks once per desync, but a buggy or hostile one could ask without end,
    // and each snapshot costs the host's main thread. One already on its way will do.
    requestSnapshot(guest) {
        if (!guest.ready || guest.resyncTimer) return;
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
        const bytes = await gzip(snapshotToJSON(this.lockstep.snapshot()));
        if (generation !== guest.snapshotGeneration) return;
        if (!this.sendTo(guest, JSON.stringify({ type: "snapshot", bytes: bytes.length }))) return;
        for (let offset = 0; offset < bytes.length; offset += SnapshotChunkBytes) {
            if (!this.sendTo(guest, bytes.slice(offset, offset + SnapshotChunkBytes))) return;
        }
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
            this.drop(guest);
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
        for (const mapping of releases.values()) this.lockstep.input({ kind: "key", mapping, down: false });
    }

    drop(guest) {
        if (this.guests.get(guest.id) !== guest) return;
        this.guests.delete(guest.id);
        clearTimeout(guest.resyncTimer);
        this.releaseKeys(guest);
        guest.pc.close();
        if (guest.welcomed) notify(`A guest left (${this.connectedCount()} connected).`);
    }

    // A page kept for the back button comes back as an ordinary one. The keys let go
    // as the keyboard leaves the session, BREAK among them, are applied before the loop does.
    close() {
        if (this.closed) return;
        this.closed = true;
        this.polling = false;
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
    }
}

export class SessionGuest {
    constructor(context, room) {
        this.context = context;
        this.room = room;
        this.id = randomId();
        this.pc = null;
        this.channel = null;
        this.lockstep = null;
        this.incoming = null;
        this.buffering = null;
        this.restored = Promise.resolve();
        this.left = false;
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
        const answer = await this.awaitAnswer();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        await opened(channel);
        keyboard.setInput(
            sessionInput(processor.sysvia, (input) => this.send({ type: "input", input }), { allowBreak: false }),
        );
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
        }
    }

    // Commits that follow a snapshot wait for it to be restored; snapshots are
    // restored in the order they came, so a second one cannot overtake the first.
    receiveCommit(commit) {
        if (!isValidCommit(commit)) {
            this.fail("the host sent a commit this page cannot read");
            return;
        }
        const waiting = this.incoming ?? this.buffering;
        if (waiting) waiting.commits.push(commit);
        else this.lockstep?.receive(commit);
    }

    welcome({ model, version }) {
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
        if (this.lockstep) {
            this.lockstep.resync();
        } else {
            this.lockstep = new LockstepGuest(processor, (reason) => this.desynced(reason));
            loop.setLockstep(this.lockstep);
            notify(`Joined "${this.room}".`);
        }
        if (this.buffering === snapshot) this.buffering = null;
        for (const commit of snapshot.commits) this.lockstep.receive(commit);
    }

    desynced(reason) {
        console.warn(`Shared session: ${reason}; asking the host to resync`);
        this.send({ type: "resync", reason });
    }

    hostLeft() {
        if (this.left) return;
        notify("Lost the host; the machine carries on here on its own.");
        this.leave();
    }

    fail(reason) {
        if (this.left) return;
        notify(`Leaving the session: ${reason}.`);
        this.leave();
    }

    leave() {
        this.left = true;
        holdAnalogue(this.context.processor, false);
        this.context.processor.sysvia.cmos.leaveSession();
        this.context.loop.setLockstep(null);
        this.context.keyboard.setInput(null);
        this.pc?.close();
    }
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
    const session = params.server ? new SessionHost(context, params.server) : new SessionGuest(context, params.client);
    session.start().catch((error) => {
        notify(`The session couldn't start: ${error.message}`);
        console.error(error);
    });
}
