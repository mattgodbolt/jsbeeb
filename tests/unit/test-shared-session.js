// @vitest-environment jsdom
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    MaxConnectingGuests,
    MinResyncIntervalMs,
    SessionGuest,
    SessionHost,
    sessionInput,
    startSessionFromUrl,
} from "../../src/web/shared-session.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { LockstepHost } from "../../src/lockstep.js";
import { Cmos } from "../../src/cmos.js";

const CyclesPerSecond = 2000000;
const MsPerMinute = 60 * 1000;

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
        fdc: { drives: [] },
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
        keyboard: { isPasting: false, setInput: vi.fn() },
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
    async function hosting(offers = [{ guest: "g1", sdp: "offer" }]) {
        const processor = fakeProcessor();
        const listOffers = vi.fn(async () => offers.splice(0));
        const host = new SessionHost(fakeContext({ processor, rendezvous: { listOffers } }), "room");
        hosts.push(host);
        await host.start();
        await settle();
        return { host, processor };
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

    it("welcomes a guest with its model and version, then sends the machine", async () => {
        await hosting();
        const channel = await joined();
        expect(channel.messages()[0]).toEqual({ type: "welcome", model: "BBC B with 8271 (DFS 1.2)", version: "1.0" });
        expect(channel.snapshots()[0].at).toBe(1000);
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
        for (let i = 0; i < 10 && channel.messages().length === 0; ++i) await Promise.resolve();
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

    it("opens only a few connections at a time, however many offers are waiting", async () => {
        const offers = Array.from({ length: MaxConnectingGuests + 2 }, (_, i) => ({ guest: `g${i}`, sdp: "offer" }));
        await hosting(offers);
        expect(peers).toHaveLength(MaxConnectingGuests);
    });
});

describe("SessionGuest", () => {
    function snapshotMessages(cycles, commits = [], { rtcBaseMs = 0, rtcOffsetMs = 0 } = {}) {
        const processor = fakeProcessor({ cycles });
        processor.sysvia.cmos.timeOffset = rtcOffsetMs;
        const snapshot = new LockstepHost(
            processor,
            () => {},
            () => {},
            { rtcBaseMs },
        ).snapshot();
        const bytes = gzipSync(snapshotToJSON(snapshot));
        return [
            message({ type: "snapshot", bytes: bytes.length }),
            { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) },
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

    it("goes back to running on its own if it cannot join", async () => {
        const context = fakeContext({
            rendezvous: { postOffer: vi.fn(async () => Promise.reject(new Error("No such room"))) },
        });
        await expect(new SessionGuest(context, "room").start()).rejects.toThrow("No such room");
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
        expect(context.keyboard.setInput).toHaveBeenLastCalledWith(null);
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
        const rtcOffsetMs = 60 * 1000;
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
