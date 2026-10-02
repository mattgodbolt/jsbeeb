// @vitest-environment jsdom
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionContext, SessionGuest, SessionHost, sessionInput } from "../../src/web/shared-session.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";

const CyclesPerSecond = 2000000;

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
    it("sends a key as its place on the matrix, with no SHIFT override when it has none", () => {
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
            keyMapping: layout.keyMapping,
            setMapped: vi.fn(),
            keyboardState: () => ({ keys: [] }),
            restoreKeyboard: vi.fn(),
            cmos: { store: [0], timeOffset: 0, joinSession: vi.fn() },
        },
    };
    return processor;
}

function fakeContext({ processor = fakeProcessor(), rendezvous = {} } = {}) {
    return new SessionContext({
        processor,
        model: { name: "BBC B", synonyms: ["B-DFS1.2"], isMaster: false, cyclesPerSecond: CyclesPerSecond },
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
    });
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const message = (body) => ({ data: JSON.stringify(body) });

beforeEach(() => {
    peers = [];
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
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

    it("welcomes a guest with its model by a URL-safe name, then sends the machine", async () => {
        const { host } = await hosting();
        const channel = await joined();
        expect(channel.messages()[0]).toEqual({ type: "welcome", model: "B-DFS1.2", version: "1.0" });
        expect(channel.snapshots()[0].at).toBe(1000);
        host.close();
    });

    it("lets go of a departing guest's keys on every machine", async () => {
        const { host, processor } = await hosting();
        const channel = await joined();
        channel.emit("message", message({ type: "input", input: { kind: "key", mapping: [4, 1], down: true } }));
        channel.emit("message", message({ type: "bye" }));
        host.lockstep.execute(0);
        expect(processor.sysvia.setMapped.mock.calls).toEqual([
            [[4, 1], 1],
            [[4, 1], 0],
        ]);
        expect(peers[0].closed).toBe(true);
        host.close();
    });

    it("takes only well-formed keys from a guest, never BREAK", async () => {
        const { host, processor } = await hosting();
        const channel = await joined();
        channel.emit("message", message({ type: "input", input: { kind: "break", down: true } }));
        channel.emit("message", message({ type: "input", input: { kind: "key", mapping: [99, 1], down: true } }));
        channel.emit("message", { data: "not json" });
        host.lockstep.execute(0);
        expect(processor.sysvia.setMapped).not.toHaveBeenCalled();
        host.close();
    });

    it("drops a guest whose channel cannot take more, rather than stopping", async () => {
        const { host } = await hosting();
        const channel = await joined();
        channel.full = true;
        expect(host.lockstep.execute(100)).toBe(true);
        expect(peers[0].closed).toBe(true);
        host.close();
    });

    it("sends a guest that keeps asking at most one snapshot per interval", async () => {
        const { host } = await hosting();
        const channel = await joined();
        for (let i = 0; i < 3; ++i) channel.emit("message", message({ type: "resync", reason: "test" }));
        await settle();
        expect(channel.snapshots()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2000);
        await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(2));
        host.close();
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
        host.close();
    });

    it("opens only a few connections at a time, however many offers are waiting", async () => {
        const offers = Array.from({ length: 6 }, (_, i) => ({ guest: `g${i}`, sdp: "offer" }));
        const { host } = await hosting(offers);
        expect(peers).toHaveLength(4);
        host.close();
    });
});

describe("SessionGuest", () => {
    function snapshotMessages(cycles, commits = []) {
        const bytes = gzipSync(snapshotToJSON({ state: { cycles }, keyboard: { keys: [] }, at: cycles, cmos: [0] }));
        return [
            message({ type: "snapshot", bytes: bytes.length }),
            { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) },
            ...commits.map((commit) => message({ type: "commit", ...commit })),
        ];
    }

    async function joining(rendezvous) {
        const context = fakeContext({ rendezvous });
        await new SessionGuest(context, "room").start();
        return { context, channel: peers[0].channel };
    }

    it("goes back to running on its own if it cannot join", async () => {
        const context = fakeContext({
            rendezvous: { postOffer: vi.fn(async () => Promise.reject(new Error("No such room"))) },
        });
        await expect(new SessionGuest(context, "room").start()).rejects.toThrow("No such room");
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
        expect(context.keyboard.setInput).toHaveBeenLastCalledWith(null);
    });

    it("restores each snapshot in turn and replays the commits that follow it", async () => {
        const { context, channel } = await joining();
        const messages = [
            ...snapshotMessages(100, [{ at: 100, upTo: 150, inputs: [] }]),
            ...snapshotMessages(500, [{ at: 500, upTo: 600, inputs: [] }]),
        ];
        for (const each of messages) channel.emit("message", each);
        const { processor } = context;
        await vi.waitFor(() => expect(processor.restoreState).toHaveBeenCalledTimes(2));
        expect(processor.restoreState.mock.calls.map(([state]) => state.cycles)).toEqual([100, 500]);
        const lockstep = context.loop.setSession.mock.calls.at(-1)[0];
        await vi.waitFor(() => expect(lockstep.behind()).toBe(100));
    });

    it("leaves the session on a commit it cannot read", async () => {
        const { context, channel } = await joining();
        channel.emit("message", message({ type: "commit", at: "soon", upTo: 1, inputs: [] }));
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
    });

    it("leaves the session on a snapshot of an impossible size", async () => {
        const { context, channel } = await joining();
        channel.emit("message", message({ type: "snapshot", bytes: -1 }));
        expect(context.loop.setSession).toHaveBeenLastCalledWith(null);
    });

    it("reloads as the host's model, by the page's own URL builder", async () => {
        const { context, channel } = await joining();
        channel.emit("message", message({ type: "welcome", model: "Master", version: "1.0" }));
        expect(context.urlState.urlWith).toHaveBeenCalledWith(expect.objectContaining({ model: "Master" }));
        expect(channel.messages().at(-1)).toEqual({ type: "bye" });
    });
});
