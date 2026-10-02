// A shared session in the browser: the host's machine runs as usual and its
// inputs and cycles stream to guests over WebRTC data channels, which the
// rendezvous only helps to open. `?server=<room>` hosts and `?client=<room>`
// joins. See docs/shared-sessions-design.md for the protocol and its limits.

import { cycleCount, isValidInput, LockstepGuest, LockstepHost } from "../lockstep.js";
import { isSameModel, snapshotFromJSON, snapshotToJSON } from "../snapshot.js";
import { createRendezvousClient } from "./rendezvous-client.js";
import { toast } from "./toast.js";

const IceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const IceGatheringTimeoutMs = 3000;
const HostPollMs = 1500;
const GuestPollMs = 1000;
const AnswerTimeoutMs = 30000;
const ConnectTimeoutMs = 20000;
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

/**
 * Keyboard input for a session: keys are mapped to the matrix here, with this
 * person's layout, and handed to `send` as session inputs.
 */
function sessionInput(processor, send, { allowBreak }) {
    const { sysvia } = processor;
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
        while (keyboard.isPasting) await delay(GuestPollMs);
        this.secret = await rendezvous.createRoom(this.room);
        this.rtcBaseMs = Date.now() - (cycleCount(processor) * 1000) / model.cyclesPerSecond;
        if (model.isMaster) {
            const { cmos } = processor.sysvia;
            cmos.joinSession(cmos.store, this.context.sessionClock(this.rtcBaseMs));
        }
        this.lockstep = new LockstepHost(processor, (commit) => this.broadcast(JSON.stringify(commit)));
        loop.setSession(this.lockstep);
        keyboard.setInput(sessionInput(processor, (input) => this.lockstep.input(input), { allowBreak: true }));
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
                    if (!this.guests.has(offer.guest)) this.answer(offer);
                }
            } catch (error) {
                console.warn(`Shared session: polling the rendezvous failed: ${error.message}`);
            }
            await delay(HostPollMs);
        }
    }

    async answer({ guest: id, sdp }) {
        const pc = new RTCPeerConnection({ iceServers: IceServers });
        const guest = { id, pc, channel: null, ready: false, backlog: [] };
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
                channel.send(JSON.stringify({ type: "welcome", model: name, version }));
                this.sendSnapshot(guest);
                notify(`A guest joined (${this.connectedCount()} connected).`);
            },
            () => this.drop(guest),
        );
    }

    connectedCount() {
        return [...this.guests.values()].filter((guest) => guest.channel?.readyState === "open").length;
    }

    fromGuest(guest, data) {
        let message;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (message.type === "input" && message.input?.kind === "key" && isValidInput(message.input)) {
            this.lockstep.input(message.input);
        } else if (message.type === "bye") {
            this.drop(guest);
        } else if (message.type === "resync" && guest.ready) {
            console.log(`Shared session: resyncing a guest: ${message.reason}`);
            this.sendSnapshot(guest);
        }
    }

    // Taken between two executes, so the last commit ended exactly here, and anything
    // the guest is sent from now on carries on from it. Commits made while the snapshot
    // is compressed wait in the guest's backlog.
    async sendSnapshot(guest) {
        const { processor } = this.context;
        guest.ready = false;
        guest.backlog = [];
        const json = snapshotToJSON({
            state: processor.snapshotState({ includeRoms: true }),
            at: cycleCount(processor),
            rtcBaseMs: this.rtcBaseMs,
            cmos: [...processor.sysvia.cmos.store],
        });
        const bytes = await gzip(json);
        const { channel } = guest;
        if (channel?.readyState !== "open") return;
        channel.send(JSON.stringify({ type: "snapshot", bytes: bytes.length }));
        for (let offset = 0; offset < bytes.length; offset += SnapshotChunkBytes) {
            channel.send(bytes.slice(offset, offset + SnapshotChunkBytes));
        }
        for (const commit of guest.backlog) channel.send(commit);
        guest.backlog = [];
        guest.ready = true;
    }

    broadcast(commit) {
        for (const guest of this.guests.values()) {
            if (guest.ready) {
                if (guest.channel.readyState === "open") guest.channel.send(commit);
            } else if (guest.channel) {
                guest.backlog.push(commit);
            }
        }
    }

    drop(guest) {
        if (this.guests.get(guest.id) !== guest) return;
        this.guests.delete(guest.id);
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
    }

    async start() {
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
            sessionInput(processor, (input) => this.send({ type: "input", input }), { allowBreak: false }),
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
        if (this.channel.readyState === "open") this.channel.send(JSON.stringify(message));
    }

    fromHost(data) {
        if (this.reloading) return;
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
                if (this.incoming) this.incoming.commits.push(message);
                else this.lockstep?.receive(message);
                break;
        }
    }

    welcome({ model, version }) {
        if (version !== this.context.version) {
            notify(
                `The host runs jsbeeb ${version} and this is ${this.context.version}; whoever is older should reload.`,
            );
            this.leave();
            return;
        }
        if (!isSameModel(model, this.context.model.name)) {
            const url = new URL(window.location.href);
            url.searchParams.set("model", model);
            this.reloading = true;
            this.send({ type: "bye" });
            window.location.replace(url);
        }
    }

    receiveChunk(chunk) {
        const incoming = this.incoming;
        if (!incoming) return;
        incoming.bytes.set(chunk, incoming.received);
        incoming.received += chunk.length;
        if (incoming.received >= incoming.bytes.length) this.restore(incoming);
    }

    async restore({ bytes, commits }) {
        const { processor, model, loop } = this.context;
        const { state, at, rtcBaseMs, cmos } = snapshotFromJSON(await gunzip(bytes));
        processor.restoreState(state);
        if (cycleCount(processor) !== at) throw new Error(`Restored to cycle ${cycleCount(processor)}, not ${at}`);
        if (model.isMaster) processor.sysvia.cmos.joinSession(cmos, this.context.sessionClock(rtcBaseMs));
        if (this.lockstep) {
            this.lockstep.resync();
        } else {
            this.lockstep = new LockstepGuest(processor, (reason) => {
                console.warn(`Shared session: ${reason}; asking the host to resync`);
                this.send({ type: "resync", reason });
            });
            loop.setSession(this.lockstep);
            notify(`Joined "${this.room}".`);
        }
        this.incoming = null;
        for (const commit of commits) this.lockstep.receive(commit);
    }

    hostLeft() {
        if (this.left) return;
        notify("The host has gone; the machine carries on here on its own.");
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
    let session = null;
    if (params.server) session = new SessionHost(context, params.server);
    else if (params.client) session = new SessionGuest(context, params.client);
    session?.start().catch((error) => {
        notify(`The session couldn't start: ${error.message}`);
        console.error(error);
    });
    return session;
}
