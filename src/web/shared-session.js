// A shared session in the browser: the host's machine runs as usual and its
// inputs and cycles stream to guests over WebRTC data channels, which the
// rendezvous only helps to open. `?server=<room>` hosts and `?client=<room>`
// joins. See docs/shared-sessions-design.md for the protocol and its limits.

import { cycleCount, isValidCommit, isValidInput, LockstepGuest, LockstepHost } from "../lockstep.js";
import { isSameModel, snapshotFromJSON, snapshotToJSON } from "../snapshot.js";
import { createRendezvousClient } from "./rendezvous-client.js";
import { toast } from "./toast.js";

const IceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const IceGatheringTimeoutMs = 3000;
const HostPollMs = 1500;
const GuestPollMs = 1000;
const PasteWaitMs = 500;
const AnswerTimeoutMs = 30000;
const ConnectTimeoutMs = 20000;
const MinResyncIntervalMs = 2000;
// Offers anyone who knows the room's name can post; this bounds the connections they can make the host open.
const MaxConnectingGuests = 4;
const SnapshotChunkBytes = 16 * 1024;
const ToastTitle = "Shared session";

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
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
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
        mapping: mapping.slice(0, mapping[2] === undefined ? 2 : 3),
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
    };
}

/** Everything a session needs from the page, gathered once in main.js. */
export class SessionContext {
    constructor({ processor, model, loop, keyboard, version, rendezvous = createRendezvousClient() }) {
        this.processor = processor;
        this.model = model;
        this.loop = loop;
        this.keyboard = keyboard;
        this.version = version;
        this.rendezvous = rendezvous;
    }

    sessionClock(baseMs) {
        const { processor } = this;
        return () => baseMs + (cycleCount(processor) * 1000) / processor.model.cyclesPerSecond;
    }
}

export class SessionHost {
    constructor(context, room) {
        this.context = context;
        this.room = room;
        this.guests = new Map();
        this.secret = null;
        this.closed = false;
    }

    async start() {
        const { processor, model, loop, keyboard, rendezvous } = this.context;
        while (keyboard.isPasting) await delay(PasteWaitMs);
        this.secret = await rendezvous.createRoom(this.room);
        this.rtcBaseMs = Date.now() - (cycleCount(processor) * 1000) / model.cyclesPerSecond;
        if (model.isMaster) {
            const { cmos } = processor.sysvia;
            cmos.joinSession(cmos.store, this.context.sessionClock(this.rtcBaseMs), cmos.timeOffset);
        }
        this.lockstep = new LockstepHost(
            processor,
            (commit) => this.broadcast(JSON.stringify(commit)),
            () => this.resyncEveryone(),
        );
        loop.setSession(this.lockstep);
        keyboard.setInput(sessionInput(processor.sysvia, (input) => this.lockstep.input(input), { allowBreak: true }));
        window.addEventListener("pagehide", () => this.close());
        const link = new URL(window.location.href);
        link.search = `?client=${encodeURIComponent(this.room)}`;
        link.hash = "";
        notify(`Hosting "${this.room}". Guests join at ${link}`);
        this.poll();
    }

    async poll() {
        while (!this.closed) {
            try {
                const offers = await this.context.rendezvous.listOffers(this.room, this.secret);
                for (const offer of offers) {
                    if (!this.guests.has(offer.guest) && this.connectingCount() < MaxConnectingGuests) {
                        this.answer(offer);
                    }
                }
            } catch (error) {
                console.warn(`Shared session: polling the rendezvous failed: ${error.message}`);
            }
            await delay(HostPollMs);
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
        const guest = { id, pc, channel: null, ready: false, backlog: [], held: new Map(), lastSnapshotMs: 0 };
        this.guests.set(id, guest);
        pc.addEventListener("datachannel", ({ channel }) => this.adopt(guest, channel));
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
                // A synonym, which unlike some names has no spaces to survive the guest's URL.
                const name = model.synonyms[0] ?? model.name;
                if (!this.sendTo(guest, JSON.stringify({ type: "welcome", model: name, version }))) return;
                this.sendSnapshot(guest);
                notify(`A guest joined (${this.connectedCount()} connected).`);
            },
            () => this.drop(guest),
        );
    }

    fromGuest(guest, data) {
        let message;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (message.type === "input" && message.input?.kind === "key" && isValidInput(message.input)) {
            const { mapping, down } = message.input;
            if (down) guest.held.set(mappingKey(mapping), mapping);
            else guest.held.delete(mappingKey(mapping));
            this.lockstep.input(message.input);
        } else if (message.type === "bye") {
            this.drop(guest);
        } else if (message.type === "resync") {
            console.log(`Shared session: resyncing a guest: ${message.reason}`);
            this.requestSnapshot(guest);
        }
    }

    // A guest asks once per desync, but a buggy or hostile one could ask without end,
    // and each snapshot costs the host's main thread.
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

    resyncEveryone() {
        for (const guest of this.guests.values()) {
            if (guest.ready) this.sendSnapshot(guest);
        }
    }

    // Taken between two executes, so the last commit ended exactly here, and anything
    // the guest is sent from now on carries on from it. Commits made while the snapshot
    // is compressed wait in the guest's backlog.
    async sendSnapshot(guest) {
        const { processor } = this.context;
        const { cmos } = processor.sysvia;
        guest.ready = false;
        guest.backlog = [];
        guest.lastSnapshotMs = Date.now();
        const json = snapshotToJSON({
            state: processor.snapshotState({ includeRoms: true }),
            keyboard: processor.sysvia.keyboardState(),
            at: cycleCount(processor),
            rtcBaseMs: this.rtcBaseMs,
            cmos: [...cmos.store],
            rtcOffsetMs: cmos.timeOffset,
        });
        const bytes = await gzip(json);
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

    // Whatever the guest was holding is let go, or it would stay down on every machine.
    drop(guest) {
        if (this.guests.get(guest.id) !== guest) return;
        this.guests.delete(guest.id);
        clearTimeout(guest.resyncTimer);
        for (const mapping of guest.held.values()) this.lockstep?.input({ kind: "key", mapping, down: false });
        guest.pc.close();
        if (guest.ready) notify(`A guest left (${this.connectedCount()} connected).`);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        for (const guest of this.guests.values()) guest.pc.close();
        this.context.rendezvous.deleteRoom(this.room, this.secret).catch(() => {});
    }
}

export class SessionGuest {
    constructor(context, room) {
        this.context = context;
        this.room = room;
        this.id = randomId();
        this.lockstep = null;
        this.incoming = null;
        this.buffering = null;
        this.restored = Promise.resolve();
        this.resyncRequested = false;
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
        // Nothing runs until the host's snapshot arrives.
        loop.setSession({ execute: () => true });
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
        if (data instanceof ArrayBuffer) {
            this.receiveChunk(new Uint8Array(data));
            return;
        }
        const message = JSON.parse(data);
        switch (message.type) {
            case "welcome":
                this.welcome(message);
                break;
            case "snapshot":
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
        if (version !== this.context.version) {
            this.fail(
                `the host runs jsbeeb ${version} and this is ${this.context.version}; whoever is older should reload`,
            );
            return;
        }
        if (!isSameModel(model, this.context.model.name)) {
            // Rebuilt by hand: URLSearchParams would write spaces as "+", which the page's own parser keeps.
            const others = window.location.search
                .slice(1)
                .split("&")
                .filter((param) => param && !param.startsWith("model="));
            this.send({ type: "bye" });
            this.left = true;
            window.location.replace(
                `${window.location.pathname}?${[...others, `model=${encodeURIComponent(model)}`].join("&")}`,
            );
        }
    }

    receiveChunk(chunk) {
        const incoming = this.incoming;
        if (!incoming) return;
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
        const { processor, model, loop } = this.context;
        const { state, keyboard, at, rtcBaseMs, cmos, rtcOffsetMs } = snapshotFromJSON(await gunzip(snapshot.bytes));
        if (this.left) return;
        processor.restoreState(state);
        processor.sysvia.restoreKeyboard(keyboard);
        if (cycleCount(processor) !== at) throw new Error(`restored to cycle ${cycleCount(processor)}, not ${at}`);
        if (model.isMaster) processor.sysvia.cmos.joinSession(cmos, this.context.sessionClock(rtcBaseMs), rtcOffsetMs);
        if (this.lockstep) {
            this.lockstep.resync();
        } else {
            this.lockstep = new LockstepGuest(processor, (reason) => this.desynced(reason));
            loop.setSession(this.lockstep);
            notify(`Joined "${this.room}".`);
        }
        this.resyncRequested = false;
        if (this.buffering === snapshot) this.buffering = null;
        for (const commit of snapshot.commits) this.lockstep.receive(commit);
    }

    desynced(reason) {
        if (this.resyncRequested) return;
        this.resyncRequested = true;
        console.warn(`Shared session: ${reason}; asking the host to resync`);
        this.send({ type: "resync", reason });
    }

    hostLeft() {
        if (this.left) return;
        notify("The host has gone; the machine carries on here on its own.");
        this.leave();
    }

    fail(reason) {
        if (this.left) return;
        notify(`Leaving the session: ${reason}.`);
        this.leave();
    }

    leave() {
        this.left = true;
        this.context.loop.setSession(null);
        this.context.keyboard.setInput(null);
        this.pc?.close();
    }
}

/** Starts the session the URL asks for, if any. */
export function startSessionFromUrl(params, context) {
    if (!params.server && !params.client) return null;
    const { model, processor } = context;
    if (model.isAtom || processor.hasTube) {
        notify("Shared sessions need a BBC Model B or Master, without a second processor.");
        return null;
    }
    const session = params.server ? new SessionHost(context, params.server) : new SessionGuest(context, params.client);
    session.start().catch((error) => {
        notify(`The session couldn't start: ${error.message}`);
        console.error(error);
    });
    return session;
}
