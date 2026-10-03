// @vitest-environment jsdom
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    AnswerTimeoutMs,
    ConnectTimeoutMs,
    MaxConnectingGuests,
    MinResyncIntervalMs,
    SessionGuest,
    SessionHost,
    sessionInput,
    startSessionFromUrl,
} from "../../src/web/shared-session.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { LockstepHost } from "../../src/lockstep.js";
import { AdcCentreValue } from "../../src/adc.js";
import { OfferLifetimeSeconds } from "../../rendezvous/handler.js";
import { Cmos } from "../../src/cmos.js";

const CyclesPerSecond = 2000000;
const MsPerMinute = 60 * 1000;
// Enough turns of the microtask queue for a channel's open to reach the host, not for a gzip to finish.
const OpeningTurns = 10;

// A layout in which "a" is at [4, 1], and "@" is the same key with BBC SHIFT forced up.
const layout = {
    keyMapping: (key, shiftDown) => ({ a: [4, 1], "@": shiftDown ? [4, 1, false] : undefined })[key],
};

function sent(allowBreak, act) {
    const inputs = [];
    act(sessionInput(layout, (input) => inputs.push(input), { allowBreak }));
    return inputs;
}

describe("sessionInput", () => {
    it("sends a key as its place on the matrix", () => {
        expect(sent(false, (input) => input.keyDown("a", false))).toEqual([
            { kind: "key", mapping: [4, 1], down: true },
        ]);
    });

    it("lets a key go under each of its mappings, as the machine's own keyUp does", () => {
        expect(sent(false, (input) => input.keyUp("@"))).toEqual([
            { kind: "key", mapping: [4, 1, false], down: false },
        ]);
        expect(sent(false, (input) => input.keyUp("a"))).toEqual([
            { kind: "key", mapping: [4, 1], down: false },
            { kind: "key", mapping: [4, 1], down: false },
        ]);
    });

    it("sends nothing for a key the layout does not have", () => {
        expect(sent(false, (input) => input.keyDown("?", false))).toEqual([]);
    });

    it("sends BREAK only where it is allowed", () => {
        expect(sent(true, (input) => input.setReset(true))).toEqual([{ kind: "break", down: true }]);
        expect(sent(false, (input) => input.setReset(true))).toEqual([]);
    });
});

class FakeEvents {
    constructor() {
        this.listeners = {};
    }

    addEventListener(type, listener) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(listener);
    }

    emit(type, event = {}) {
        for (const listener of this.listeners[type] ?? []) listener(event);
    }
}

class FakeChannel extends FakeEvents {
    constructor() {
        super();
        this.readyState = "open";
        this.sent = [];
        this.full = false;
    }

    send(data) {
        if (this.full) throw new Error("send queue is full");
        this.sent.push(data);
    }

    messages() {
        return this.sent.filter((data) => typeof data === "string").map((data) => JSON.parse(data));
    }

    // Each snapshot here fits one chunk.
    snapshots() {
        const snapshots = [];
        let expecting = false;
        for (const data of this.sent) {
            if (typeof data === "string") {
                expecting = JSON.parse(data).type === "snapshot";
            } else if (expecting) {
                snapshots.push(snapshotFromJSON(gunzipSync(Buffer.from(data)).toString()));
                expecting = false;
            }
        }
        return snapshots;
    }
}

let peers;

class FakePeer extends FakeEvents {
    constructor() {
        super();
        this.localDescription = { sdp: "local sdp" };
        this.iceGatheringState = "complete";
        this.closed = false;
        peers.push(this);
    }

    async setRemoteDescription() {}
    async setLocalDescription() {}
    async createAnswer() {
        return {};
    }
    async createOffer() {
        return {};
    }

    createDataChannel() {
        this.channel = new FakeChannel();
        return this.channel;
    }

    close() {
        this.closed = true;
    }
}

function fakeProcessor({ cycles = 1000 } = {}) {
    const processor = {
        cycleSeconds: 0,
        currentCycles: cycles,
        targetCycles: cycles,
        model: { cyclesPerSecond: CyclesPerSecond },
        hasTube: false,
        a: 0,
        x: 0,
        y: 0,
        s: 0,
        pc: 0,
        p: { asByte: () => 0 },
        ramRomOs: new Uint8Array(16),
        romOffset: 16,
        resetLine: true,
        setReset(resetOn) {
            this.resetLine = !resetOn;
        },
        fdc: { drives: [] },
        adconverter: { setFixedValue: vi.fn() },
        execute(count) {
            this.targetCycles += count;
            this.currentCycles = Math.max(this.currentCycles, this.targetCycles);
            return true;
        },
        snapshotState: () => ({ cycles: processor.currentCycles }),
        restoreState: vi.fn((state) => {
            processor.currentCycles = processor.targetCycles = state.cycles;
        }),
        sysvia: {
            keys: [],
            keyMapping: layout.keyMapping,
            setMapped: vi.fn(),
            keyboardState: () => ({ keys: [] }),
            restoreKeyboard: vi.fn(),
            cmos: new Cmos(null),
        },
    };
    return processor;
}

function fakeContext({ processor = fakeProcessor(), rendezvous = {}, model = {} } = {}) {
    return {
        processor,
        model: { name: "BBC B with 8271 (DFS 1.2)", cyclesPerSecond: CyclesPerSecond, ...model },
        loop: { setSession: vi.fn() },
        keyboard: { isPasting: false, setInput: vi.fn(), cancelPaste: vi.fn() },
        urlState: { urlWith: vi.fn(() => "about:blank") },
        version: "1.0",
        rendezvous: {
            createRoom: vi.fn(async () => "secret"),
            deleteRoom: vi.fn(async () => {}),
            listOffers: vi.fn(async () => []),
            postAnswer: vi.fn(async () => {}),
            postOffer: vi.fn(async () => {}),
            getAnswer: vi.fn(async () => "answer sdp"),
            ...rendezvous,
        },
    };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const message = (body) => ({ data: JSON.stringify(body) });
// The second the session clock shows: wall time here, read as UTC.
const wallClockSecondMs = (fromMs = Date.now()) =>
    Math.floor((fromMs - new Date().getTimezoneOffset() * MsPerMinute) / 1000) * 1000;

let hosts;

beforeEach(() => {
    peers = [];
    hosts = [];
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
    for (const host of hosts) host.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
});

describe("SessionHost", () => {
    async function hosting(offers = [{ guest: "g1", sdp: "offer" }], rendezvous = {}) {
        const processor = fakeProcessor();
        const listOffers = vi.fn(async () => offers.splice(0));
        const context = fakeContext({ processor, rendezvous: { listOffers, ...rendezvous } });
        const host = new SessionHost(context, "room");
        hosts.push(host);
        await host.start();
        await settle();
        return { host, processor, context };
    }

    function connect() {
        const channel = new FakeChannel();
        peers.at(-1).emit("datachannel", { channel });
        return channel;
    }

    async function joined() {
        const channel = connect();
        await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(1));
        return channel;
    }

    const keyMessage = (input) => message({ type: "input", input });

    it("holds the analogue inputs at the centre for the session, and gives back an ordinary page when it closes", async () => {
        const { host, processor, context } = await hosting([]);
        expect(processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(AdcCentreValue);
        host.close();
        expect(processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(null);
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
        expect(context.keyboard.setInput).toHaveBeenLastCalledWith(null);
        expect(processor.sysvia.cmos.bbcDateTime()).toBeInstanceOf(Date);
    });

    it("opens its room again if it finds it gone, and says so if it cannot", async () => {
        const gone = Object.assign(new Error("Rendezvous list offers failed with status 404"), { status: 404 });
        const listOffers = vi.fn(async () => Promise.reject(gone));
        const createRoom = vi.fn(async () => "secret");
        const { context } = await hosting([], { listOffers, createRoom });
        expect(createRoom).toHaveBeenCalledTimes(2);
        createRoom.mockRejectedValue(new Error("Room already exists"));
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        const polls = listOffers.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(listOffers.mock.calls.length).toBe(polls);
        expect(context.rendezvous.createRoom).toHaveBeenCalledTimes(3);
    });

    it("welcomes a guest with its model and version, then sends the machine", async () => {
        await hosting();
        const channel = await joined();
        expect(channel.messages()[0]).toEqual({ type: "welcome", model: "BBC B with 8271 (DFS 1.2)", version: "1.0" });
        expect(channel.snapshots()[0].at).toBe(1000);
    });

    it("sends a joiner the commits made while its snapshot was compressed, after it", async () => {
        const { host } = await hosting();
        const channel = connect();
        for (let i = 0; i < OpeningTurns && channel.messages().length === 0; ++i) await Promise.resolve();
        host.lockstep.execute(100);
        host.lockstep.execute(100);
        await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(1));
        const commits = channel.messages().filter((each) => each.type === "commit");
        expect(commits.map(({ at, upTo }) => [at, upTo])).toEqual([
            [1000, 1100],
            [1100, 1200],
        ]);
        expect(channel.snapshots()[0].at).toBe(1000);
        const lastChunk = channel.sent.findLastIndex((data) => typeof data !== "string");
        const firstCommit = channel.sent.findIndex(
            (data) => typeof data === "string" && JSON.parse(data).type === "commit",
        );
        expect(firstCommit).toBeGreaterThan(lastChunk);
    });

    it("ignores a guest's second channel, which would cost another snapshot", async () => {
        await hosting();
        const channel = await joined();
        const second = connect();
        await settle();
        expect(second.sent).toEqual([]);
        expect(channel.snapshots()).toHaveLength(1);
    });

    it("lets go of a departing guest's keys on every machine", async () => {
        const { host, processor } = await hosting();
        const channel = await joined();
        channel.emit("message", keyMessage({ kind: "key", mapping: [4, 1], down: true }));
        channel.emit("message", message({ type: "bye" }));
        host.lockstep.execute(0);
        expect(processor.sysvia.setMapped.mock.calls).toEqual([
            [[4, 1], 1],
            [[4, 1], 0],
        ]);
        expect(peers[0].closed).toBe(true);
    });

    it("takes only well-formed keys from a guest, never BREAK, and passes on only what it checked", async () => {
        const { host, processor } = await hosting();
        const channel = await joined();
        channel.emit("message", { data: "null" });
        channel.emit("message", keyMessage({ kind: "break", down: true }));
        channel.emit("message", keyMessage({ kind: "key", mapping: [99, 1], down: true }));
        channel.emit("message", { data: "not json" });
        channel.emit("message", keyMessage({ kind: "key", mapping: [4, 1], down: true, padding: "x".repeat(1000) }));
        host.lockstep.execute(0);
        expect(processor.sysvia.setMapped.mock.calls).toEqual([[[4, 1], 1]]);
        expect(channel.messages().at(-1).inputs).toEqual([{ kind: "key", mapping: [4, 1], down: true }]);
    });

    it("drops a guest whose channel cannot take more, rather than stopping", async () => {
        const { host } = await hosting();
        const channel = await joined();
        channel.full = true;
        expect(host.lockstep.execute(100)).toBe(true);
        expect(peers[0].closed).toBe(true);
    });

    it("sends a guest that keeps asking at most one snapshot per interval", async () => {
        await hosting();
        const channel = await joined();
        for (let i = 0; i < 3; ++i) channel.emit("message", message({ type: "resync" }));
        await settle();
        expect(channel.snapshots()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(MinResyncIntervalMs);
        await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(2));
    });

    it("sends a guest whose snapshot is still on its way the machine from after a jump instead", async () => {
        const { host, processor } = await hosting();
        const channel = connect();
        // The welcome and the snapshot start together; the jump comes while it is compressed.
        for (let i = 0; i < OpeningTurns && channel.messages().length === 0; ++i) await Promise.resolve();
        expect(channel.messages()).toEqual([expect.objectContaining({ type: "welcome" })]);
        processor.currentCycles = processor.targetCycles = 50;
        host.lockstep.execute(0);
        await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(1));
        await settle();
        expect(channel.snapshots().map((snapshot) => snapshot.at)).toEqual([50]);
    });

    it("runs the clock from cycles, from the wall time here, starting again from it after a jump", async () => {
        const { host, processor } = await hosting([]);
        const { cmos } = processor.sysvia;
        const started = Date.now();
        expect(cmos.bbcDateTime().getTime()).toBe(wallClockSecondMs(started));
        host.lockstep.execute(CyclesPerSecond * 5);
        expect(cmos.bbcDateTime().getTime()).toBe(wallClockSecondMs(started + 5000));
        processor.cycleSeconds = 20;
        host.lockstep.execute(0);
        expect(cmos.bbcDateTime().getTime()).toBe(wallClockSecondMs(started));
    });

    it("opens only a few connections at a time, and frees the place of one that never completes", async () => {
        const offers = Array.from({ length: MaxConnectingGuests + 2 }, (_, i) => ({ guest: `g${i}`, sdp: "offer" }));
        await hosting([], { listOffers: vi.fn(async () => offers) });
        expect(peers).toHaveLength(MaxConnectingGuests);
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(peers.slice(0, MaxConnectingGuests).every((peer) => peer.closed)).toBe(true);
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(peers).toHaveLength(MaxConnectingGuests + 2);
    });

    it("answers each offer once, even if answering it failed", async () => {
        const offer = { guest: "g1", sdp: "offer" };
        const postAnswer = vi.fn(async () =>
            Promise.reject(new Error("Rendezvous post answer failed with status 500")),
        );
        await hosting([], { listOffers: vi.fn(async () => [offer]), postAnswer });
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(postAnswer).toHaveBeenCalledTimes(1);
        expect(peers).toHaveLength(1);
    });
});

describe("SessionGuest", () => {
    function snapshotMessages(cycles, commits = [], { rtcBaseMs = 0, rtcOffsetMs = 0, chunks = 1 } = {}) {
        const processor = fakeProcessor({ cycles });
        processor.sysvia.cmos.timeOffset = rtcOffsetMs;
        const snapshot = new LockstepHost(
            processor,
            () => {},
            () => {},
            { rtcBaseMs },
        ).snapshot();
        const bytes = gzipSync(snapshotToJSON(snapshot));
        const chunkBytes = Math.ceil(bytes.length / chunks);
        const pieces = [];
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            const end = Math.min(offset + chunkBytes, bytes.length);
            pieces.push({ data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + end) });
        }
        return [
            message({ type: "snapshot", bytes: bytes.length }),
            ...pieces,
            ...commits.map((commit) => message({ type: "commit", ...commit })),
        ];
    }

    async function joining(rendezvous) {
        const context = fakeContext({ rendezvous });
        await new SessionGuest(context, "room").start();
        const channel = peers[0].channel;
        const deliver = (messages) => messages.forEach((each) => channel.emit("message", each));
        const lockstep = () => context.loop.setSession.mock.calls.at(-1)[0];
        return { context, channel, deliver, lockstep };
    }

    const resyncsAsked = (channel) => channel.messages().filter((each) => each.type === "resync").length;

    it("waits for an offer's answer for less time than the rendezvous keeps the offer", () => {
        expect(AnswerTimeoutMs).toBeLessThan(OfferLifetimeSeconds * 1000);
    });

    it("sends the host its keys but never BREAK", async () => {
        const { context, channel } = await joining();
        const input = context.keyboard.setInput.mock.calls.at(-1)[0];
        input.keyDown("a", false);
        input.setReset(true);
        expect(channel.messages().map((each) => each.input?.kind)).toEqual(["key"]);
    });

    it("cancels its own paste or autoboot when it joins, and before every restore", async () => {
        const { context, deliver } = await joining();
        const { cancelPaste } = context.keyboard;
        expect(cancelPaste).toHaveBeenCalledTimes(1);
        deliver(snapshotMessages(100));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        expect(cancelPaste).toHaveBeenCalledTimes(2);
        expect(cancelPaste.mock.invocationCallOrder[1]).toBeLessThan(
            context.processor.restoreState.mock.invocationCallOrder[0],
        );
    });

    it("goes back to running on its own if it cannot join", async () => {
        const context = fakeContext({
            rendezvous: { postOffer: vi.fn(async () => Promise.reject(new Error("No such room"))) },
        });
        await expect(new SessionGuest(context, "room").start()).rejects.toThrow("No such room");
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
        expect(context.keyboard.setInput).toHaveBeenLastCalledWith(null);
    });

    it("holds the analogue inputs at the centre while it is in the session", async () => {
        const { context, channel } = await joining();
        expect(context.processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(AdcCentreValue);
        channel.emit("close");
        expect(context.processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(null);
    });

    it("puts a snapshot back together from its chunks", async () => {
        const { context, deliver } = await joining();
        deliver(snapshotMessages(700, [], { chunks: 3 }));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        expect(context.processor.restoreState.mock.calls[0][0].cycles).toBe(700);
    });

    it("leaves the session on more snapshot than the host said it would send", async () => {
        const { context, channel, deliver } = await joining();
        const [header, ...chunks] = snapshotMessages(700);
        channel.emit("message", message({ ...JSON.parse(header.data), bytes: 10 }));
        deliver(chunks);
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
    });

    it("restores each snapshot in turn and replays the commits that follow it", async () => {
        const { context, deliver, lockstep } = await joining();
        deliver([
            ...snapshotMessages(100, [{ at: 100, upTo: 150, inputs: [] }]),
            ...snapshotMessages(500, [{ at: 500, upTo: 600, inputs: [] }]),
        ]);
        const { processor } = context;
        await vi.waitFor(() => expect(processor.restoreState).toHaveBeenCalledTimes(2));
        expect(processor.restoreState.mock.calls.map(([state]) => state.cycles)).toEqual([100, 500]);
        await vi.waitFor(() => expect(lockstep().behind()).toBe(100));
    });

    it("asks for a resync once when it parts from the host, and again after the next restore", async () => {
        const { context, channel, deliver, lockstep } = await joining();
        const bogus = (at) => ({ at, upTo: at + 50, inputs: [], hash: "bogus" });
        deliver(snapshotMessages(100, [bogus(100), bogus(150)]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        lockstep().execute(100);
        expect(resyncsAsked(channel)).toBe(1);
        deliver(snapshotMessages(300, [bogus(300)]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(2));
        lockstep().execute(100);
        expect(resyncsAsked(channel)).toBe(2);
    });

    it("gives the guest the host's clock and offset, and its own back when the host goes", async () => {
        const { context, channel, deliver } = await joining();
        const { cmos } = context.processor.sysvia;
        const rtcBaseMs = Date.UTC(2026, 1, 10, 12, 0, 0);
        const rtcOffsetMs = MsPerMinute;
        deliver(snapshotMessages(CyclesPerSecond * 3, [], { rtcBaseMs, rtcOffsetMs }));
        await vi.waitFor(() => expect(cmos.bbcDateTime().getTime()).toBe(rtcBaseMs + 3000 + rtcOffsetMs));
        channel.emit("close");
        expect(cmos.bbcDateTime().getTime()).toBe(Math.floor(Date.now() / 1000) * 1000);
    });

    it.each([
        ["a commit it cannot read", { type: "commit", at: "soon", upTo: 1, inputs: [] }],
        ["a snapshot of an impossible size", { type: "snapshot", bytes: -1 }],
        ["a welcome from another version", { type: "welcome", model: "BBC B with 8271 (DFS 1.2)", version: "0.9" }],
        ["a welcome with no machine in it", { type: "welcome", model: 42, version: "1.0" }],
        ["a welcome naming no machine there is", { type: "welcome", model: "Nonesuch", version: "1.0" }],
        ["a message that is not an object", null],
    ])("leaves the session on %s", async (_, body) => {
        const { context, channel } = await joining();
        channel.emit("message", message(body));
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
        expect(context.urlState.urlWith).not.toHaveBeenCalled();
    });

    it("stays as it is when the host is the same machine", async () => {
        const { context, channel } = await joining();
        channel.emit("message", message({ type: "welcome", model: "B-DFS1.2", version: "1.0" }));
        expect(context.urlState.urlWith).not.toHaveBeenCalled();
        expect(context.loop.setSession).not.toHaveBeenLastCalledWith(null);
    });

    it("reloads as the host's model, by the page's own URL builder", async () => {
        const { context, channel } = await joining();
        channel.emit("message", message({ type: "welcome", model: "BBC Master 128 (DFS)", version: "1.0" }));
        expect(context.urlState.urlWith).toHaveBeenCalledWith(
            expect.objectContaining({ model: "BBC Master 128 (DFS)" }),
        );
        expect(channel.messages().at(-1)).toEqual({ type: "bye" });
    });
});

describe("startSessionFromUrl", () => {
    async function started(params, contextOptions) {
        const context = fakeContext(contextOptions);
        startSessionFromUrl(params, context);
        await settle();
        return context.rendezvous;
    }

    it("hosts with ?server=, which wins over ?client=", async () => {
        const rendezvous = await started({ server: "here", client: "there" });
        expect(rendezvous.createRoom).toHaveBeenCalledWith("here");
        expect(rendezvous.postOffer).not.toHaveBeenCalled();
    });

    it("joins with ?client=", async () => {
        const rendezvous = await started({ client: "there" });
        expect(rendezvous.postOffer).toHaveBeenCalledWith("there", expect.any(String), "local sdp");
    });

    it.each([
        ["no session asked for", {}, {}],
        ["an Atom", { server: "here" }, { model: { isAtom: true } }],
        ["a second processor", { server: "here" }, { processor: Object.assign(fakeProcessor(), { hasTube: true }) }],
    ])("starts nothing for %s", async (_, params, contextOptions) => {
        const rendezvous = await started(params, contextOptions);
        expect(rendezvous.createRoom).not.toHaveBeenCalled();
        expect(peers).toEqual([]);
    });
});
