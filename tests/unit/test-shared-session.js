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
    cleanName,
    sessionInput,
    startSessionFromUrl,
} from "../../src/web/shared-session.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { LockstepHost, MaxGuestLagSeconds } from "../../src/lockstep.js";
import { AdcCentreValue } from "../../src/adc.js";
import { OfferLifetimeSeconds } from "../../rendezvous/handler.js";
import { Cmos } from "../../src/cmos.js";
import { StatsIntervalMs } from "../../src/web/session-log.js";
import { MaxWaitingKeys } from "../../src/web/session-sequencer.js";
import { domFromIndexHtml } from "./helpers.js";

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

describe("cleanName", () => {
    it.each([
        ["  Kieran ", "Kieran"],
        ["a\u0007b\nc", "abc"],
        ["\u202eabc\u2066", "abc"],
        ["a\u0085\u061cb", "ab"],
        ["\u{1F600}".repeat(40), "\u{1F600}".repeat(32)],
        ["x".repeat(100), "x".repeat(32)],
        ["\u0000 ", null],
        [42, null],
    ])("makes %j %j", (name, cleaned) => {
        expect(cleanName(name)).toBe(cleaned);
    });
});

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

    async getStats() {
        return new Map(
            [
                { id: "T", type: "transport", selectedCandidatePairId: "P" },
                {
                    id: "P",
                    type: "candidate-pair",
                    localCandidateId: "L",
                    remoteCandidateId: "R",
                    currentRoundTripTime: 0.085,
                },
                { id: "L", type: "local-candidate", candidateType: "srflx", protocol: "udp" },
                { id: "R", type: "remote-candidate", candidateType: "srflx" },
            ].map((entry) => [entry.id, entry]),
        );
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
        model: { cyclesPerSecond: CyclesPerSecond, swram: [] },
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
        // As at a breakpoint: the CPU stops here, short of its target.
        stopAt: Infinity,
        execute(count) {
            this.targetCycles += count;
            if (this.targetCycles > this.stopAt) {
                this.currentCycles = this.stopAt;
                this.stopAt = Infinity;
                return false;
            }
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
        loop: { setLockstep: vi.fn() },
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
const showLights = () => domFromIndexHtml("leds", "session-pane");
const message = (body) => ({ data: JSON.stringify(body) });
// The second the session clock shows: wall time here, read as UTC.
const wallClockSecondMs = (fromMs = Date.now()) =>
    Math.floor((fromMs - new Date().getTimezoneOffset() * MsPerMinute) / 1000) * 1000;

let hosts;

beforeEach(() => {
    peers = [];
    hosts = [];
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
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

    function connectTo(index) {
        const channel = new FakeChannel();
        peers[index].emit("datachannel", { channel });
        return channel;
    }

    const connect = () => connectTo(peers.length - 1);

    async function joined() {
        const channel = connect();
        await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(1));
        return channel;
    }

    const keyMessage = (input) => message({ type: "input", input });

    describe("the link to join", () => {
        const toastTexts = () => [...document.querySelectorAll(".toast .message")].map((each) => each.textContent);

        afterEach(() => {
            delete navigator.clipboard;
            window.history.replaceState(null, "", "/");
        });

        it("is shown and copied in the pane that opens as hosting starts, whatever the host's own URL holds", async () => {
            const writeText = vi.fn(async () => {});
            Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
            window.history.replaceState(null, "", "/?server=room&model=Master#frag");
            showLights();
            await hosting([]);
            const pane = document.getElementById("session-pane");
            expect(pane.hidden).toBe(false);
            expect(pane.querySelector(".session-link").textContent).toBe(`${window.location.origin}/?client=room`);
            pane.querySelector(".session-copy-link").click();
            await settle();
            expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?client=room`);
            expect(toastTexts()).toContain("The link to join is on the clipboard.");
        });

        it("is shown in full where there is no clipboard to copy it to", async () => {
            showLights();
            await hosting([]);
            document.querySelector(".session-copy-link").click();
            await settle();
            expect(toastTexts().at(-1)).toBe(
                `Copying needs https. Guests join at ${window.location.origin}/?client=room`,
            );
        });

        it("is shown in full when the clipboard refuses it", async () => {
            const writeText = vi.fn(async () => {
                throw new Error("not allowed");
            });
            Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
            showLights();
            await hosting([]);
            document.querySelector(".session-copy-link").click();
            await settle();
            expect(toastTexts().at(-1)).toBe(
                `Couldn't copy the link (not allowed). Guests join at ${window.location.origin}/?client=room`,
            );
        });
    });

    it("holds the analogue inputs at the centre for the session, and gives back an ordinary page when it closes", async () => {
        const { host, processor, context } = await hosting([]);
        expect(processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(AdcCentreValue);
        host.close();
        expect(processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(null);
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
        expect(context.keyboard.setInput).toHaveBeenLastCalledWith(null);
        expect(processor.sysvia.cmos.bbcDateTime()).toBeInstanceOf(Date);
    });

    it("opens its room again if it finds it gone, and says so if it cannot", async () => {
        const gone = Object.assign(new Error("Rendezvous list offers failed with status 404"), { status: 404 });
        const listOffers = vi.fn(async () => Promise.reject(gone));
        const createRoom = vi.fn(async () => "secret");
        const { host, context } = await hosting([], { listOffers, createRoom });
        expect(createRoom).toHaveBeenCalledTimes(2);
        createRoom.mockRejectedValue(new Error("Room already exists"));
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        const polls = listOffers.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(listOffers.mock.calls.length).toBe(polls);
        expect(context.rendezvous.createRoom).toHaveBeenCalledTimes(3);
        host.close();
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
    });

    it("welcomes a guest with its model, version and the host's name, then sends the machine", async () => {
        const { host } = await hosting();
        const channel = await joined();
        expect(channel.messages()[0]).toEqual({
            type: "welcome",
            model: "BBC B with 8271 (DFS 1.2)",
            version: "1.0",
            name: host.name,
        });
        expect(channel.snapshots()[0].at).toBe(1000);
    });

    it("sends a joiner the commits made while its snapshot was compressed, after it", async () => {
        const { host } = await hosting();
        const channel = connect();
        for (let i = 0; i < OpeningTurns && channel.messages().length === 0; ++i) await Promise.resolve();
        host.execute(100);
        host.execute(100);
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
        host.execute(0);
        expect(processor.sysvia.setMapped.mock.calls).toEqual([
            [[4, 1], 1],
            [[4, 1], 0],
        ]);
        expect(peers[0].closed).toBe(true);
    });

    describe("control", () => {
        const MsCycles = CyclesPerSecond / 1000;
        const A = [4, 1];
        const keyA = { kind: "key", mapping: A, down: true };
        const sentOf = (channel, type) => channel.messages().filter((each) => each.type === type);
        async function twoGuests() {
            const { host, processor } = await hosting([
                { guest: "g1", sdp: "offer" },
                { guest: "g2", sdp: "offer" },
            ]);
            const first = connectTo(0);
            const second = connectTo(1);
            await vi.waitFor(() => expect(first.snapshots()).toHaveLength(1));
            await vi.waitFor(() => expect(second.snapshots()).toHaveLength(1));
            return { host, processor, first, second };
        }
        const commit = (at, upTo, inputs = []) => message({ type: "commit", at, upTo, inputs });

        it("passes to a guest that asks, from where the machine is, with the keys still waiting for it", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "input", input: keyA, at: 1000 + 50 * MsCycles, snapshots: 1 }));
            channel.emit("message", message({ type: "take" }));
            expect(sentOf(channel, "handover")).toEqual([{ type: "handover", at: 1000 }]);
            expect(sentOf(channel, "input")).toEqual([
                { type: "input", input: keyA, at: 1000 + 50 * MsCycles, source: "g1" },
            ]);
            expect(host.report().events).toContainEqual(expect.objectContaining({ event: "control", guest: "g1" }));
        });

        it("passes on a key pressed to take it, as well as the key", async () => {
            await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "input", input: keyA, take: true }));
            expect(sentOf(channel, "handover")).toHaveLength(1);
        });

        it("replays the commits of the guest in control and passes them to the others", async () => {
            const { host, processor, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000, [keyA]));
            host.execute(5000);
            expect(processor.currentCycles).toBe(3000);
            expect(processor.sysvia.setMapped).toHaveBeenCalledWith(A, 1);
            expect(sentOf(second, "commit").at(-1)).toMatchObject({ at: 1000, upTo: 3000, inputs: [keyA] });
            expect(sentOf(first, "commit").filter((each) => each.at >= 1000)).toEqual([]);
        });

        it("sends this page's keys to the guest in control, stamped", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "take" }));
            host.input(keyA);
            const [sent] = sentOf(channel, "input");
            expect(sent).toMatchObject({ input: keyA, source: "host" });
            expect(sent.at).toBeGreaterThan(1000);
        });

        it.each([
            ["sends a commit that does not follow on", commit(1500, 3000)],
            ["sends a commit with BREAK in it", commit(1000, 3000, [{ kind: "break", down: true }])],
        ])("is taken back, and everyone started afresh, when the guest in control %s", async (_, bad) => {
            const { host, processor, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", bad);
            await vi.waitFor(() => expect(second.snapshots()).toHaveLength(2));
            await vi.waitFor(() => expect(first.snapshots()).toHaveLength(2));
            host.input(keyA);
            host.execute(100);
            expect(processor.sysvia.setMapped).toHaveBeenCalledWith(A, 1);
        });

        it("comes back to the host from the end of the last commit when the guest in control leaves", async () => {
            const { host, processor, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            first.emit("message", message({ type: "bye" }));
            host.execute(5000);
            host.execute(100);
            expect(processor.currentCycles).toBe(3100);
            expect(sentOf(second, "commit").at(-1)).toMatchObject({ at: 3000, upTo: 3100 });
            expect(second.snapshots()).toHaveLength(1);
        });

        it("goes from one guest to another through the first stopping", async () => {
            const { host, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            second.emit("message", message({ type: "take" }));
            expect(sentOf(first, "release")).toHaveLength(1);
            expect(sentOf(second, "handover")).toEqual([]);
            first.emit(
                "message",
                message({ type: "released", at: 3000, waiting: [{ source: "g2", input: keyA, at: 4000 }] }),
            );
            expect(sentOf(second, "handover")).toEqual([{ type: "handover", at: 3000 }]);
            expect(sentOf(second, "input")).toEqual([{ type: "input", input: keyA, at: 4000, source: "g2" }]);
            host.execute(5000);
        });

        it.each([
            ["a key", keyA],
            ["BREAK", { kind: "break", down: true }],
        ])("commits %s due at the next execute before handing over", async (_, input) => {
            const { host } = await hosting();
            const channel = await joined();
            host.input(input);
            channel.emit("message", message({ type: "take" }));
            const sent = channel.messages();
            const committed = sent.findIndex((each) => each.type === "commit" && each.inputs.length > 0);
            expect(sent[committed]).toMatchObject({ at: 1000, upTo: 1000, inputs: [input] });
            expect(committed).toBeLessThan(sent.findIndex((each) => each.type === "handover"));
            expect(sentOf(channel, "input")).toEqual([]);
        });

        it("applies itself a key it sent the guest in control that no commit carried, if that guest leaves", async () => {
            const { host, processor, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            host.input(keyA);
            first.emit("message", commit(1000, 3000));
            first.emit("message", message({ type: "bye" }));
            host.execute(5000);
            host.execute(CyclesPerSecond);
            expect(processor.sysvia.setMapped).toHaveBeenCalledWith(A, 1);
        });

        it.each([
            ["the host presses BREAK", (host) => host.input({ kind: "break", down: true })],
            [
                "the host's machine jumps",
                (host, processor) => {
                    processor.currentCycles = processor.targetCycles = 50;
                    host.execute(100);
                },
            ],
            [
                "the host's replay disagrees with the guest in control",
                (host, processor, first) => {
                    first.emit("message", message({ type: "commit", at: 1000, upTo: 3000, inputs: [], hash: "nope" }));
                    host.execute(5000);
                },
            ],
            [
                "the guest in control goes quiet",
                (host) => {
                    vi.advanceTimersByTime(3001);
                    host.execute(100);
                    host.execute(100);
                },
            ],
        ])("comes back to the host when %s", async (_, happen) => {
            const { host, processor, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            happen(host, processor, first);
            await vi.waitFor(() => expect(first.snapshots().length).toBeGreaterThan(1));
            expect(
                host
                    .report()
                    .events.filter((each) => each.event === "control")
                    .at(-1),
            ).toMatchObject({ guest: "host" });
            const before = sentOf(second, "commit").length;
            host.execute(100);
            expect(sentOf(second, "commit").length).toBeGreaterThan(before);
        });

        const keyAUp = { kind: "key", mapping: A, down: false };
        const takeAndBreak = (host) => host.input({ kind: "break", down: true });

        it("taking back at once, applies the keys in commits it passed on but had not yet replayed", async () => {
            const { host, processor, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000, [keyA]));
            host.execute(5000);
            first.emit("message", commit(3000, 5000, [keyAUp]));
            takeAndBreak(host);
            host.execute(100);
            expect(processor.sysvia.setMapped.mock.calls).toContainEqual([A, 0]);
        });

        it.each([
            [
                "its machine jumps",
                (host, processor, first) => {
                    first.emit("message", commit(3000, 5000, [keyAUp]));
                    processor.currentCycles = processor.targetCycles = 50;
                    host.execute(100);
                },
            ],
            [
                "its replay disagrees",
                (host, processor, first) => {
                    first.emit("message", message({ type: "commit", at: 3000, upTo: 5000, inputs: [], hash: "nope" }));
                    first.emit("message", commit(5000, 7000, [keyAUp]));
                    host.execute(5000);
                },
            ],
        ])("taking back at once because %s, applies the keys in commits it had not replayed", async (_, happen) => {
            const { host, processor, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000, [keyA]));
            host.execute(5000);
            happen(host, processor, first);
            host.execute(100);
            expect(processor.sysvia.setMapped.mock.calls).toContainEqual([A, 0]);
        });

        it("keeps the session's clock when its replay disagrees rather than its machine jumping", async () => {
            const { host, first } = await twoGuests();
            const [before] = first.snapshots();
            first.emit("message", message({ type: "take" }));
            vi.advanceTimersByTime(60000);
            first.emit("message", message({ type: "commit", at: 1000, upTo: 3000, inputs: [], hash: "nope" }));
            host.execute(5000);
            await vi.waitFor(() => expect(first.snapshots()).toHaveLength(2));
            expect(first.snapshots()[1].rtcBaseMs).toBe(before.rtcBaseMs);
        });

        it("taking back at once, applies the keys it sent the guest in control that no commit carried", async () => {
            const { host, processor, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            host.input(keyA);
            takeAndBreak(host);
            host.execute(CyclesPerSecond);
            expect(processor.sysvia.setMapped).toHaveBeenCalledWith(A, 1);
        });

        it("applies a key it sent the guest in control only once, when a commit carried it before that guest left", async () => {
            const { host, processor, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            host.input(keyA);
            first.emit("message", commit(1000, 3000, [keyA]));
            first.emit("message", message({ type: "bye" }));
            host.execute(5000);
            host.execute(CyclesPerSecond);
            expect(processor.sysvia.setMapped.mock.calls.filter(([, down]) => down === 1)).toHaveLength(1);
        });

        it("leaves control with a guest that keeps sending commits", async () => {
            const { host, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            for (let at = 1000; at < 9000; at += 2000) {
                first.emit("message", commit(at, at + 2000));
                vi.advanceTimersByTime(1000);
                host.execute(2000);
            }
            expect(first.snapshots()).toHaveLength(1);
            expect(
                host
                    .report()
                    .events.filter((each) => each.event === "control")
                    .at(-1),
            ).toMatchObject({ guest: "g1" });
        });

        it("hands a guest whose snapshot is still on its way control once it has it", async () => {
            const { host, first } = await twoGuests();
            host.resyncEveryone();
            first.emit("message", message({ type: "take" }));
            expect(sentOf(first, "handover")).toEqual([]);
            await vi.waitFor(() => expect(first.snapshots()).toHaveLength(2));
            await vi.waitFor(() => expect(sentOf(first, "handover")).toHaveLength(1));
            const sent = first.messages();
            expect(sent.findIndex((each) => each.type === "handover")).toBeGreaterThan(
                sent.findLastIndex((each) => each.type === "snapshot"),
            );
        });

        it("asks the guest in control to stop for one that asked while its snapshot was on its way, once it has it", async () => {
            const { host, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            host.execute(5000);
            second.emit("message", message({ type: "resync", reason: "test" }));
            vi.advanceTimersByTime(MinResyncIntervalMs);
            second.emit("message", message({ type: "take" }));
            expect(sentOf(first, "release")).toEqual([]);
            await vi.waitFor(() => expect(second.snapshots()).toHaveLength(2));
            await vi.waitFor(() => expect(sentOf(first, "release")).toHaveLength(1));
        });

        it("hands control to a guest that asked while the host was taking it back, once it has", async () => {
            const { host, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            first.emit("message", message({ type: "bye" }));
            second.emit("message", message({ type: "take" }));
            expect(sentOf(second, "handover")).toEqual([]);
            host.execute(5000);
            expect(sentOf(second, "handover")).toEqual([{ type: "handover", at: 3000 }]);
        });

        it("forgets a guest that asked for control and then left", async () => {
            const { host, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            second.emit("message", message({ type: "take" }));
            second.emit("message", message({ type: "bye" }));
            first.emit("message", message({ type: "released", at: 3000, waiting: [] }));
            host.execute(5000);
            expect(
                host
                    .report()
                    .events.filter((each) => each.event === "control")
                    .at(-1),
            ).toMatchObject({ guest: "host" });
        });

        it("takes control back at once if the guest in control stops anywhere but the end of its last commit", async () => {
            const { first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            second.emit("message", message({ type: "take" }));
            first.emit("message", message({ type: "released", at: 2500, waiting: [] }));
            await vi.waitFor(() => expect(second.snapshots()).toHaveLength(2));
        });

        it("does not pass the guest in control its own keys back", async () => {
            await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "take" }));
            channel.emit("message", message({ type: "input", input: keyA, own: true }));
            expect(sentOf(channel, "input")).toEqual([]);
        });

        it("starts the session's clock afresh when its machine jumps while a guest is in control", async () => {
            const { host, processor, first } = await twoGuests();
            const [before] = first.snapshots();
            first.emit("message", message({ type: "take" }));
            processor.currentCycles = processor.targetCycles = 50;
            host.execute(100);
            await vi.waitFor(() => expect(first.snapshots()).toHaveLength(2));
            expect(first.snapshots()[1].rtcBaseMs).not.toBe(before.rtcBaseMs);
        });

        it("keeps a key it pressed to take control back down long enough for the keyboard scan, though it went in late", async () => {
            showLights();
            const { host, first, second } = await twoGuests();
            document.querySelector("#session-pane .session-take-on-key").click();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            host.input(keyA);
            vi.advanceTimersByTime(84);
            host.input(keyAUp);
            first.emit("message", message({ type: "released", at: 3000, waiting: [] }));
            host.execute(5000);
            host.execute(CyclesPerSecond);
            const keys = sentOf(second, "commit").flatMap(({ at, inputs }) => inputs.map(({ down }) => [down, at]));
            expect(keys[0]).toEqual([true, 3000]);
            expect(keys[1]).toEqual([false, 3000 + 40 * MsCycles]);
        });

        it("keeps a key it pressed to take control back down long enough when it is let go just after control came", async () => {
            showLights();
            const { host, first, second } = await twoGuests();
            document.querySelector("#session-pane .session-take-on-key").click();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            host.input(keyA);
            first.emit("message", message({ type: "released", at: 3000, waiting: [] }));
            vi.advanceTimersByTime(60);
            host.execute(5000);
            host.execute(100);
            host.input(keyAUp);
            host.execute(CyclesPerSecond);
            const keys = sentOf(second, "commit").flatMap(({ at, inputs }) => inputs.map(({ down }) => [down, at]));
            expect(keys[0]).toEqual([true, 3000]);
            expect(keys[1][1] - 3000).toBeGreaterThanOrEqual(40 * MsCycles);
        });

        it("puts BREAK in at once, ahead of keys of its own still waiting", async () => {
            showLights();
            const { host, first, second } = await twoGuests();
            document.querySelector("#session-pane .session-take-on-key").click();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            host.input(keyA);
            vi.advanceTimersByTime(84);
            host.input(keyAUp);
            first.emit("message", message({ type: "released", at: 3000, waiting: [] }));
            host.execute(5000);
            host.input({ kind: "break", down: true });
            host.execute(100);
            const breakCommit = sentOf(second, "commit").find(({ inputs }) =>
                inputs.some(({ kind }) => kind === "break"),
            );
            expect(breakCommit.at).toBe(3000);
        });

        it("puts in at once two keys this page presses together, as a machine of its own would", async () => {
            const { host, second } = await twoGuests();
            host.input(keyA);
            vi.advanceTimersByTime(5);
            host.input({ kind: "key", mapping: [0, 0], down: true });
            host.execute(100);
            const [commitOf] = sentOf(second, "commit").filter(({ inputs }) => inputs.length > 0);
            expect(commitOf.inputs).toHaveLength(2);
        });

        it("resyncs another guest from its own machine and the commits it has not yet replayed", async () => {
            const { host, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000, [keyA]));
            first.emit("message", commit(3000, 5000));
            host.execute(1000);
            second.emit("message", message({ type: "resync", reason: "test" }));
            vi.advanceTimersByTime(MinResyncIntervalMs);
            await vi.waitFor(() => expect(second.snapshots()).toHaveLength(2));
            const [snapshot] = second.snapshots().slice(-1);
            const after = second.messages().slice(second.messages().findLastIndex((each) => each.type === "snapshot"));
            const commits = after.filter((each) => each.type === "commit");
            expect(commits[0].at).toBe(snapshot.at);
            expect(commits.at(-1)).toMatchObject({ upTo: 5000 });
        });
    });

    describe("a guest's keys", () => {
        const MsCycles = CyclesPerSecond / 1000;
        const A = [4, 1];
        const B = [5, 2];
        const key = (down, mapping = A) => keyMessage({ kind: "key", mapping, down });
        // Stamped as a guest does, `ms` into the session's first snapshot, which joined() has the guest restore.
        const stamped = (down, ms, mapping = A, extra = {}) =>
            message({
                type: "input",
                input: { kind: "key", mapping, down },
                at: 1000 + ms * MsCycles,
                snapshots: 1,
                ...extra,
            });
        const applied = (channel) =>
            channel
                .messages()
                .filter((each) => each.type === "commit" && each.inputs.length > 0)
                .flatMap((each) => each.inputs.map((input) => [input.mapping.join(), input.down, each.at]));
        const appliedMs = (channel) => applied(channel).map(([name, down, at]) => [name, down, (at - 1000) / MsCycles]);
        const run = (host, count, ms) => {
            for (let i = 0; i < count; ++i) host.execute(ms * MsCycles);
        };
        const lastStats = (host) =>
            host
                .report()
                .events.filter((each) => each.event === "stats")
                .at(-1);

        it("without a stamp go in as they come", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", key(true, A));
            run(host, 1, 50);
            channel.emit("message", key(true, B));
            run(host, 1, 10);
            channel.emit("message", key(false, A));
            run(host, 1, 0);
            expect(appliedMs(channel)).toEqual([
                ["4,1", true, 0],
                ["5,2", true, 50],
                ["4,1", false, 60],
            ]);
        });

        it("go in at the cycle they were stamped with, however the network bunched them", async () => {
            const { host } = await hosting();
            const channel = await joined();
            for (const each of [stamped(true, 10), stamped(false, 30), stamped(true, 30, B), stamped(false, 70, B)])
                channel.emit("message", each);
            run(host, 5, 20);
            expect(appliedMs(channel)).toEqual([
                ["4,1", true, 10],
                ["4,1", false, 30],
                ["5,2", true, 30],
                ["5,2", false, 70],
            ]);
        });

        it("keep their cycles through one long execute", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", stamped(true, 10));
            channel.emit("message", stamped(false, 30));
            run(host, 1, 100);
            expect(appliedMs(channel)).toEqual([
                ["4,1", true, 10],
                ["4,1", false, 30],
            ]);
        });

        it("keep the order they came in, whatever their stamps say", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", stamped(true, 50));
            channel.emit("message", stamped(false, 20));
            run(host, 4, 20);
            expect(appliedMs(channel)).toEqual([
                ["4,1", true, 50],
                ["4,1", false, 50],
            ]);
        });

        it("that come too late for their cycle go in at once, and are counted", async () => {
            const { host } = await hosting();
            const channel = await joined();
            run(host, 1, 50);
            channel.emit("message", stamped(true, 10));
            vi.advanceTimersByTime(StatsIntervalMs);
            run(host, 1, 0);
            expect(appliedMs(channel)).toEqual([["4,1", true, 50]]);
            expect(lastStats(host)).toMatchObject({ lateKeys: 1, lateKeyMaxMs: 40 });
        });

        it("held up past their cycles go in as far apart as they were typed, then on time again", async () => {
            const { host } = await hosting();
            const channel = await joined();
            run(host, 1, 200);
            for (const each of [stamped(true, 10), stamped(false, 30), stamped(true, 50, B)])
                channel.emit("message", each);
            run(host, 3, 20);
            channel.emit("message", stamped(false, 300, B));
            run(host, 3, 20);
            expect(appliedMs(channel)).toEqual([
                ["4,1", true, 200],
                ["4,1", false, 220],
                ["5,2", true, 240],
                ["5,2", false, 300],
            ]);
        });

        it("held up past their cycles make the lag up over the keys that follow", async () => {
            const { host } = await hosting();
            const channel = await joined();
            run(host, 1, 300);
            for (const each of [
                stamped(true, 10),
                stamped(false, 30),
                stamped(true, 330, B),
                stamped(false, 360, B),
                stamped(true, 500),
            ])
                channel.emit("message", each);
            run(host, 10, 50);
            expect(appliedMs(channel).map(([, , ms]) => ms)).toEqual([300, 320, 360, 390, 500]);
        });

        it("stamped after the host restarted its machine go in on their own cycles", async () => {
            const { host, processor } = await hosting();
            const channel = await joined();
            run(host, 1, 300);
            channel.emit("message", stamped(true, 290));
            run(host, 1, 20);
            processor.currentCycles = processor.targetCycles = 1000;
            run(host, 1, 0);
            await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(2));
            channel.emit("message", stamped(false, 30, A, { snapshots: 2 }));
            run(host, 3, 20);
            expect(appliedMs(channel).at(-1)).toEqual(["4,1", false, 30]);
        });

        it("after one with no stamp go in on their own cycles, whatever the run before it", async () => {
            const { host } = await hosting();
            const channel = await joined();
            run(host, 1, 300);
            channel.emit("message", stamped(true, 10));
            channel.emit("message", key(false));
            channel.emit("message", stamped(true, 330));
            run(host, 3, 20);
            expect(appliedMs(channel).map(([, , ms]) => ms)).toEqual([300, 300, 330]);
        });

        it("stamped before a resync the host sent go in at once", async () => {
            const { host } = await hosting();
            const channel = await joined();
            host.resyncEveryone();
            await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(2));
            channel.emit("message", stamped(true, 30));
            run(host, 1, 0);
            expect(appliedMs(channel)).toEqual([["4,1", true, 0]]);
        });

        it.each([
            ["stamped before the guest's latest snapshot", stamped(true, 30, A, { snapshots: 0 })],
            ["stamped implausibly far ahead", stamped(true, 3000)],
            ["with a stamp that is not a cycle", stamped(true, 30, A, { at: 1000.5 })],
        ])("%s go in at once", async (_, input) => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", input);
            run(host, 1, 0);
            expect(appliedMs(channel)).toEqual([["4,1", true, 0]]);
        });

        it("that waited are logged when they go in, with their stamp, when they came and the guest's time", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", stamped(false, 40, A, { ms: 12.5 }));
            vi.advanceTimersByTime(30);
            run(host, 3, 20);
            const releases = host.report().events.filter((each) => each.event === "input" && !each.down);
            expect(releases).toEqual([
                expect.objectContaining({
                    guest: "g1",
                    guestMs: 12.5,
                    stamp: 1000 + 40 * MsCycles,
                    cycle: 1000 + 40 * MsCycles,
                }),
            ]);
            expect(releases[0].ms - releases[0].arrivedMs).toBe(30);
        });

        it("keep their cycles across a stop at a breakpoint", async () => {
            const { host, processor } = await hosting();
            const channel = await joined();
            processor.stopAt = 1000 + MsCycles;
            expect(host.execute(100 * MsCycles)).toBe(false);
            channel.emit("message", stamped(true, 21));
            channel.emit("message", stamped(false, 41));
            run(host, 4, 20);
            expect(appliedMs(channel)).toEqual([
                ["4,1", true, 21],
                ["4,1", false, 41],
            ]);
        });

        it("leave an execute with nothing waiting as one commit, overshoot and all", async () => {
            const { host, processor } = await hosting();
            const channel = await joined();
            // As the real processor does: whole instructions, so a little past the target.
            processor.execute = function (count) {
                this.targetCycles += count;
                while (this.currentCycles < this.targetCycles) this.currentCycles += 7;
                return true;
            };
            const commits = () => channel.messages().filter((each) => each.type === "commit").length;
            const before = commits();
            run(host, 10, 10);
            expect(commits()).toBe(before + 10);
            expect(processor.currentCycles - processor.targetCycles).toBeLessThan(7);
        });

        it("all go in at once when far more are waiting than anyone types, and the guest stays", async () => {
            const { host } = await hosting();
            const channel = await joined();
            for (let i = 0; i < 100; ++i) channel.emit("message", stamped(i % 2 === 0, 10 + i * 10));
            run(host, 1, 0);
            expect(applied(channel).length).toBeGreaterThan(MaxWaitingKeys);
            expect(host.connectedCount()).toBe(1);
            run(host, 60, 50);
            expect(applied(channel)).toHaveLength(100);
        });

        it("after all going in at once start a fresh run", async () => {
            const { host } = await hosting();
            const channel = await joined();
            for (let i = 0; i <= MaxWaitingKeys; ++i) channel.emit("message", stamped(i % 2 === 0, 1000 + i * 10));
            channel.emit("message", stamped(true, 50, B));
            run(host, 4, 20);
            expect(appliedMs(channel).at(-1)).toEqual(["5,2", true, 50]);
        });

        it("are let go when the guest leaves with a release still waiting", async () => {
            const { host, processor } = await hosting();
            const channel = await joined();
            channel.emit("message", stamped(true, 10));
            channel.emit("message", stamped(false, 40));
            run(host, 1, 20);
            channel.emit("message", message({ type: "bye" }));
            run(host, 3, 20);
            expect(processor.sysvia.setMapped.mock.calls).toEqual([
                [A, 1],
                [A, 0],
            ]);
        });

        it("are let go when the host closes with a release still waiting", async () => {
            const { host, processor } = await hosting();
            const channel = await joined();
            channel.emit("message", key(true));
            channel.emit("message", stamped(false, 40));
            host.close();
            expect(processor.sysvia.setMapped.mock.calls.at(-1)).toEqual([A, 0]);
        });

        it("still waiting at a jump move with the cycle count", async () => {
            const { host, processor } = await hosting();
            const channel = await joined();
            channel.emit("message", key(true));
            channel.emit("message", stamped(false, 40));
            processor.currentCycles = processor.targetCycles = 50;
            run(host, 1, 20);
            expect(processor.sysvia.setMapped.mock.calls).toEqual([[A, 1]]);
            run(host, 1, 20);
            run(host, 1, 0);
            expect(processor.sysvia.setMapped.mock.calls.at(-1)).toEqual([A, 0]);
        });
    });

    it("takes only well-formed keys from a guest, never BREAK, and passes on only what it checked", async () => {
        const { host, processor } = await hosting();
        const channel = await joined();
        channel.emit("message", { data: "null" });
        channel.emit("message", keyMessage({ kind: "break", down: true }));
        channel.emit("message", keyMessage({ kind: "key", mapping: [99, 1], down: true }));
        channel.emit("message", { data: "not json" });
        channel.emit("message", keyMessage({ kind: "key", mapping: [4, 1], down: true, padding: "x".repeat(1000) }));
        host.execute(0);
        expect(processor.sysvia.setMapped.mock.calls).toEqual([[[4, 1], 1]]);
        expect(channel.messages().at(-1).inputs).toEqual([{ kind: "key", mapping: [4, 1], down: true }]);
    });

    it("logs a guest's keys with the guest's time and the cycle they are applied at, and why it left", async () => {
        const { host } = await hosting();
        const channel = await joined();
        channel.emit(
            "message",
            message({ type: "input", input: { kind: "key", mapping: [4, 1], down: true }, ms: 12.5 }),
        );
        channel.emit("message", message({ type: "bye" }));
        expect(host.report().events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ event: "input", guest: "g1", mapping: [4, 1], down: true, guestMs: 12.5 }),
                expect.objectContaining({ event: "left", guest: "g1", reason: "it said goodbye" }),
            ]),
        );
        expect(
            host
                .report()
                .events.filter((each) => each.event === "input")
                .map((each) => each.cycle),
        ).toEqual([1000, 1000]);
    });

    it("logs how long a snapshot took to take and to send, and whether the page was visible", async () => {
        const { host } = await hosting();
        await joined();
        const { events } = host.report();
        const snapshot = events.find((each) => each.event === "snapshot");
        expect(snapshot).toMatchObject({ takeMs: expect.any(Number), tookMs: expect.any(Number) });
        expect(snapshot.takeMs).toBeLessThanOrEqual(snapshot.tookMs);
        expect(events).toContainEqual(expect.objectContaining({ event: "page", hidden: expect.any(Boolean) }));
    });

    it("logs only the numbers a guest's summary should hold, so it cannot rewrite the log", async () => {
        const { host } = await hosting();
        const channel = await joined();
        vi.advanceTimersByTime(5000);
        const stats = {
            starved: 3,
            lagMs: 40,
            hiddenFrames: 12,
            note: "<script>",
            junk: 1,
            ms: -1,
            guest: 7,
            event: 9,
        };
        channel.emit("message", message({ type: "stats", stats }));
        const logged = host.report().events.find((each) => each.event === "guest stats");
        expect(logged).toEqual({
            ms: expect.any(Number),
            event: "guest stats",
            guest: "g1",
            starved: 3,
            lagMs: 40,
            hiddenFrames: 12,
            dropped: 0,
        });
        expect(logged.ms).toBeGreaterThan(0);
    });

    it("takes one name from a guest, and at most one summary per half interval", async () => {
        const { host } = await hosting();
        const channel = await joined();
        for (const name of ["Kieran", "Matt (you)"]) channel.emit("message", message({ type: "hello", name }));
        for (let i = 0; i < 3; ++i) channel.emit("message", message({ type: "stats", stats: { lagMs: i } }));
        vi.advanceTimersByTime(StatsIntervalMs);
        channel.emit("message", message({ type: "stats", stats: { lagMs: 9 } }));
        const events = host.report().events;
        expect(events.filter((each) => each.event === "hello").map((each) => each.name)).toEqual(["Kieran"]);
        const summaries = events.filter((each) => each.event === "guest stats");
        expect(summaries.map(({ lagMs, dropped }) => [lagMs, dropped])).toEqual([
            [0, 0],
            [9, 2],
        ]);
    });

    it("sends each guest the lights once an interval, and logs and shows each connection's round trip", async () => {
        showLights();
        const { host } = await hosting();
        const channel = await joined();
        channel.emit("message", message({ type: "stats", stats: { lagMs: 30, commits: 50 } }));
        const rosters = () => channel.messages().filter((each) => each.type === "roster").length;
        const before = rosters();
        host.execute(0);
        expect(rosters()).toBe(before);
        vi.advanceTimersByTime(StatsIntervalMs);
        host.execute(0);
        await settle();
        expect(rosters()).toBe(before + 1);
        expect(host.report().events).toContainEqual(
            expect.objectContaining({ event: "connection", guest: "g1", rttMs: 85, route: "srflx/srflx" }),
        );
        host.execute(0);
        vi.advanceTimersByTime(StatsIntervalMs);
        host.execute(0);
        expect(document.querySelector("#session-panel .led").title).toBe(
            "Guest 1: keeping up, 85 ms round trip, 30 ms behind",
        );
    });

    it("shows each guest's light, and keeps a departed one's for a while", async () => {
        showLights();
        const { host } = await hosting();
        const channel = await joined();
        const lights = () => [...document.querySelectorAll("#session-panel .led")].map((light) => light.dataset.state);
        expect(lights()).toEqual(["connecting"]);
        channel.emit("message", message({ type: "stats", stats: { lagMs: 30, commits: 50 } }));
        vi.advanceTimersByTime(StatsIntervalMs);
        host.execute(0);
        expect(lights()).toEqual(["ok"]);
        expect(document.querySelector(".session-summary").textContent).toBe("1 guest");
        channel.emit("message", message({ type: "bye" }));
        expect(lights()).toEqual(["left"]);
        expect(document.querySelector(".session-summary").textContent).toBe("0 guests");
        vi.advanceTimersByTime(60000);
        host.execute(0);
        expect(lights()).toEqual([]);
    });

    it("calls each guest by the name it gives", async () => {
        showLights();
        const { host } = await hosting();
        const channel = await joined();
        channel.emit("message", message({ type: "hello", name: "Kieran" }));
        expect(document.querySelector("#session-panel .led").title).toMatch(/^Kieran: /);
        expect(host.report().events).toContainEqual(expect.objectContaining({ event: "hello", name: "Kieran" }));
    });

    it("shows every guest the same lights, its own marked", async () => {
        const { host } = await hosting([
            { guest: "g1", sdp: "offer" },
            { guest: "g2", sdp: "offer" },
        ]);
        const first = connectTo(0);
        const second = connectTo(1);
        await vi.waitFor(() => expect(second.snapshots()).toHaveLength(1));
        first.emit("message", message({ type: "hello", name: "Kieran" }));
        second.emit("message", message({ type: "hello", name: "Ana" }));
        const lastRoster = (channel) =>
            channel
                .messages()
                .filter((each) => each.type === "roster")
                .at(-1).guests;
        expect(lastRoster(first).map(({ label, you }) => [label, !!you])).toEqual([
            ["Kieran", true],
            ["Ana", false],
        ]);
        expect(lastRoster(second).map(({ label, you }) => [label, !!you])).toEqual([
            ["Kieran", false],
            ["Ana", true],
        ]);
        expect(host.connectedCount()).toBe(2);
    });

    it("logs only the resyncs it honours, so a guest asking without end cannot fill the log", async () => {
        const { host } = await hosting();
        const channel = await joined();
        for (let i = 0; i < 50; ++i) channel.emit("message", message({ type: "resync", reason: "x" }));
        expect(host.report().events.filter((each) => each.event === "resync asked")).toHaveLength(1);
    });

    it("reports the keys each guest is holding, and the keys the machine has down", async () => {
        const { host, processor } = await hosting();
        const channel = await joined();
        channel.emit("message", keyMessage({ kind: "key", mapping: [4, 1], down: true }));
        processor.sysvia.keys = [Uint8Array.of(0, 1), Uint8Array.of(0, 0)];
        const report = host.report();
        expect(report.guests).toEqual([{ id: "g1", connected: true, held: [[4, 1]] }]);
        expect(report.keysDown).toEqual([[0, 1]]);
    });

    it("drops a guest whose channel cannot take more, rather than stopping", async () => {
        const { host } = await hosting();
        const channel = await joined();
        channel.full = true;
        expect(host.execute(100)).toBe(true);
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
        expect(channel.messages()[0]).toMatchObject({ type: "welcome" });
        expect(channel.messages().some((each) => each.type === "snapshot")).toBe(false);
        processor.currentCycles = processor.targetCycles = 50;
        host.execute(0);
        await vi.waitFor(() => expect(channel.snapshots()).toHaveLength(1));
        await settle();
        expect(channel.snapshots().map((snapshot) => snapshot.at)).toEqual([50]);
    });

    it("runs the clock from cycles, from the wall time here, starting again from it after a jump", async () => {
        const { host, processor } = await hosting([]);
        const { cmos } = processor.sysvia;
        const started = Date.now();
        expect(cmos.bbcDateTime().getTime()).toBe(wallClockSecondMs(started));
        host.execute(CyclesPerSecond * 5);
        expect(cmos.bbcDateTime().getTime()).toBe(wallClockSecondMs(started + 5000));
        processor.cycleSeconds = 20;
        host.execute(0);
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
        const guest = new SessionGuest(context, "room");
        await guest.start();
        const channel = peers[0].channel;
        const deliver = (messages) => messages.forEach((each) => channel.emit("message", each));
        const lockstep = () => context.loop.setLockstep.mock.calls.at(-1)[0];
        return { guest, context, channel, deliver, lockstep };
    }

    const resyncsAsked = (channel) => channel.messages().filter((each) => each.type === "resync").length;

    it("waits for an offer's answer for less time than the rendezvous keeps the offer", () => {
        expect(AnswerTimeoutMs).toBeLessThan(OfferLifetimeSeconds * 1000);
    });

    it("says its name to the host, and calls the host by the one it was welcomed with", async () => {
        showLights();
        const context = fakeContext();
        await new SessionGuest(context, "room", "Kieran").start();
        const { channel } = peers[0];
        expect(channel.messages()[0]).toEqual({ type: "hello", name: "Kieran" });
        channel.emit("message", message({ type: "welcome", model: context.model.name, version: "1.0", name: "Matt" }));
        expect(document.querySelector("#session-panel .led").title).toMatch(/^Matt: /);
    });

    it("shows the host's list of guests, its own marked, and makes the most of a bad one", async () => {
        showLights();
        const { channel } = await joining();
        const guests = [
            { label: "Kieran", state: "ok", rttMs: 85, lagMs: 60, you: true },
            { label: "\u0007", state: "on fire", rttMs: "fast" },
        ];
        channel.emit("message", message({ type: "roster", guests }));
        const titles = [...document.querySelectorAll("#session-panel .led")].map((light) => light.title);
        expect(titles).toEqual([
            "Host: connecting",
            "Kieran (you): keeping up, 85 ms round trip, 60 ms behind",
            "Guest: out of touch",
        ]);
    });

    it("logs the inputs the host applied, with their cycle, and no lag once it has left", async () => {
        const { guest, channel, deliver } = await joining();
        const input = { kind: "key", mapping: [4, 1], down: true };
        deliver(snapshotMessages(100, [{ at: 100, upTo: 150, inputs: [{ ...input, junk: "x".repeat(1000) }] }]));
        expect(guest.report().events).toContainEqual(
            expect.objectContaining({ event: "inputs", cycle: 100, inputs: [input] }),
        );
        channel.emit("close");
        expect(guest.report().lagMs).toBeUndefined();
    });

    it("sends the host its keys but never BREAK", async () => {
        const { context, channel } = await joining();
        const input = context.keyboard.setInput.mock.calls.at(-1)[0];
        input.keyDown("a", false);
        input.setReset(true);
        const inputs = channel.messages().filter((each) => each.type === "input");
        expect(inputs.map((each) => each.input.kind)).toEqual(["key"]);
    });

    it("sends each key with the time it was pressed here", async () => {
        const { context, channel } = await joining();
        vi.advanceTimersByTime(250);
        context.keyboard.setInput.mock.calls.at(-1)[0].keyDown("a", false);
        expect(channel.messages().find((each) => each.type === "input").ms).toBeGreaterThanOrEqual(250);
    });

    describe("in control", () => {
        const A = [4, 1];
        const commitsSent = (channel) => channel.messages().filter((each) => each.type === "commit");
        async function inControl() {
            const session = await joining();
            session.deliver(snapshotMessages(100, [{ at: 100, upTo: 1000, inputs: [] }]));
            await vi.waitFor(() => expect(session.context.processor.restoreState).toHaveBeenCalledTimes(1));
            session.deliver([message({ type: "handover", at: 1000 })]);
            session.lockstep().execute(2000);
            return session;
        }

        it("takes control at the cycle it is handed, once its machine has reached it, and sends its commits", async () => {
            const { context, channel, lockstep } = await inControl();
            expect(context.processor.currentCycles).toBe(1000);
            lockstep().execute(500);
            expect(commitsSent(channel)).toEqual([expect.objectContaining({ at: 1000, upTo: 1500, inputs: [] })]);
        });

        it("applies its own keys at once, and tells the host of them", async () => {
            const { context, channel, lockstep } = await inControl();
            context.keyboard.setInput.mock.calls.at(-1)[0].keyDown("a", false);
            lockstep().execute(500);
            const [own] = channel.messages().filter((each) => each.type === "input");
            expect(own).toMatchObject({ own: true, input: { kind: "key", down: true } });
            expect(commitsSent(channel)[0].inputs).toEqual([own.input]);
        });

        it("applies the keys the host passes on at their stamps", async () => {
            const { channel, deliver, lockstep } = await inControl();
            deliver([
                message({ type: "input", input: { kind: "key", mapping: A, down: true }, at: 1200, source: "g2" }),
            ]);
            lockstep().execute(500);
            expect(commitsSent(channel).map(({ at, inputs }) => [at, inputs.length])).toEqual([
                [1000, 0],
                [1200, 1],
            ]);
        });

        it("stops where it is when asked, handing back the keys it had not applied", async () => {
            const { channel, deliver, lockstep } = await inControl();
            lockstep().execute(500);
            const later = { kind: "key", mapping: A, down: true };
            deliver([message({ type: "input", input: later, at: 100000, source: "host" })]);
            deliver([message({ type: "release" })]);
            expect(channel.messages().find((each) => each.type === "released")).toEqual({
                type: "released",
                at: 1500,
                waiting: [{ source: "host", input: later, at: 100000 }],
            });
            lockstep().execute(500);
            expect(commitsSent(channel)).toHaveLength(1);
        });

        it("keeps the keys passed on before it has reached the cycle it takes control at", async () => {
            const session = await joining();
            session.deliver(snapshotMessages(100, [{ at: 100, upTo: 1000, inputs: [] }]));
            await vi.waitFor(() => expect(session.context.processor.restoreState).toHaveBeenCalledTimes(1));
            session.deliver([
                message({ type: "handover", at: 1000 }),
                message({ type: "input", input: { kind: "key", mapping: A, down: true }, at: 1200, source: "g2" }),
            ]);
            session.lockstep().execute(2000);
            session.lockstep().execute(500);
            expect(commitsSent(session.channel).some(({ inputs }) => inputs.length === 1)).toBe(true);
        });

        it("asked to stop before it has taken control, gives it up at the cycle it was to take it at", async () => {
            const session = await joining();
            session.deliver(snapshotMessages(100, [{ at: 100, upTo: 1000, inputs: [] }]));
            await vi.waitFor(() => expect(session.context.processor.restoreState).toHaveBeenCalledTimes(1));
            const key = { kind: "key", mapping: A, down: false };
            session.deliver([
                message({ type: "handover", at: 1000 }),
                message({ type: "input", input: key, at: 1200, source: "g2" }),
                message({ type: "release" }),
            ]);
            session.lockstep().execute(2000);
            expect(session.channel.messages().find((each) => each.type === "released")).toEqual({
                type: "released",
                at: 1000,
                waiting: [{ source: "g2", input: key, at: 1200 }],
            });
            expect(commitsSent(session.channel)).toEqual([]);
        });

        it("counts the commits it sends, so its light keeps up", async () => {
            const { channel, lockstep } = await inControl();
            lockstep().execute(500);
            vi.advanceTimersByTime(StatsIntervalMs);
            lockstep().execute(500);
            const summary = channel
                .messages()
                .filter((each) => each.type === "stats")
                .at(-1).stats;
            expect(summary.commits).toBeGreaterThan(0);
        });

        it("waits quietly for the snapshot that ends its control, without asking for another", async () => {
            const { channel, deliver, lockstep } = await inControl();
            lockstep().execute(500);
            const [header] = snapshotMessages(5000, [{ at: 5000, upTo: 6000, inputs: [] }]);
            deliver([header]);
            lockstep().execute(500);
            expect(channel.messages().filter((each) => each.type === "resync")).toEqual([]);
        });

        it("greys out its Take control button while control is on its way to it", async () => {
            showLights();
            const session = await joining();
            session.deliver(snapshotMessages(100, [{ at: 100, upTo: 1000, inputs: [] }]));
            await vi.waitFor(() => expect(session.context.processor.restoreState).toHaveBeenCalledTimes(1));
            const take = document.querySelector("#session-pane .session-take");
            session.deliver([message({ type: "roster", guests: [] })]);
            expect(take.disabled).toBe(false);
            session.deliver([message({ type: "handover", at: 5000 }), message({ type: "roster", guests: [] })]);
            expect(take.disabled).toBe(true);
        });

        it("keeps a key pressed to take control down long enough for the keyboard scan, though it went in late", async () => {
            const MsCycles = CyclesPerSecond / 1000;
            const session = await joining();
            session.deliver(snapshotMessages(100, [{ at: 100, upTo: 1000, inputs: [] }]));
            await vi.waitFor(() => expect(session.context.processor.restoreState).toHaveBeenCalledTimes(1));
            const keyboard = session.context.keyboard.setInput.mock.calls.at(-1)[0];
            keyboard.keyDown("a", false);
            const [press] = session.channel.messages().filter((each) => each.type === "input");
            session.deliver([
                message({ type: "handover", at: 1000 }),
                message({ type: "input", input: press.input, at: press.at, source: session.guest.id }),
            ]);
            session.lockstep().execute(2000);
            vi.advanceTimersByTime(84);
            keyboard.keyUp("a");
            vi.advanceTimersByTime(10);
            keyboard.keyDown("a", false);
            session.lockstep().execute(press.at + 100 * MsCycles);
            const keys = commitsSent(session.channel).flatMap(({ at, inputs }) => inputs.map(({ down }) => [down, at]));
            expect(keys[0]).toEqual([true, press.at]);
            expect(keys[1]).toEqual([false, press.at + 40 * MsCycles]);
            expect(keys.at(-1)).toEqual([true, press.at + 50 * MsCycles]);
        });

        it("keeps a key pressed to take control down long enough when it is let go just after the press went in", async () => {
            const MsCycles = CyclesPerSecond / 1000;
            const session = await joining();
            session.deliver(snapshotMessages(100, [{ at: 100, upTo: 1000, inputs: [] }]));
            await vi.waitFor(() => expect(session.context.processor.restoreState).toHaveBeenCalledTimes(1));
            const keyboard = session.context.keyboard.setInput.mock.calls.at(-1)[0];
            keyboard.keyDown("a", false);
            const [press] = session.channel.messages().filter((each) => each.type === "input");
            session.deliver([
                message({ type: "handover", at: 1000 }),
                message({ type: "input", input: press.input, at: press.at, source: session.guest.id }),
            ]);
            session.lockstep().execute(2000);
            session.lockstep().execute(press.at - 1000 + 1000);
            vi.advanceTimersByTime(240);
            keyboard.keyUp("a");
            session.lockstep().execute(100 * MsCycles);
            const keys = commitsSent(session.channel).flatMap(({ at, inputs }) => inputs.map(({ down }) => [down, at]));
            expect(keys[0]).toEqual([true, press.at]);
            expect(keys[1][1] - press.at).toBeGreaterThanOrEqual(40 * MsCycles);
        });

        it("commits its own key pressed just before it is asked to stop, then stops after it", async () => {
            const { context, channel, deliver, lockstep } = await inControl();
            lockstep().execute(500);
            context.keyboard.setInput.mock.calls.at(-1)[0].keyDown("a", false);
            deliver([message({ type: "release" })]);
            const sent = channel.messages().filter((each) => each.type === "commit" || each.type === "released");
            expect(sent.at(-2)).toMatchObject({
                type: "commit",
                at: 1500,
                upTo: 1500,
                inputs: [{ kind: "key", down: true }],
            });
            expect(sent.at(-1)).toEqual({ type: "released", at: 1500, waiting: [] });
        });

        it("asks for nothing more after it stops", async () => {
            const { channel, deliver, lockstep } = await inControl();
            lockstep().execute(500);
            deliver([message({ type: "release" })]);
            lockstep().execute(500);
            lockstep().execute(500);
            expect(channel.messages().filter((each) => each.type === "resync")).toEqual([]);
        });

        it("gives it up when the host sends a snapshot", async () => {
            const { context, channel, deliver, lockstep } = await inControl();
            deliver(snapshotMessages(5000, [{ at: 5000, upTo: 6000, inputs: [] }]));
            await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(2));
            lockstep().execute(500);
            expect(commitsSent(channel)).toEqual([]);
        });
    });

    describe("stamps each key", () => {
        const MsCycles = CyclesPerSecond / 1000;
        const sentKeys = (channel) => channel.messages().filter((each) => each.type === "input");
        const press = (context) => context.keyboard.setInput.mock.calls.at(-1)[0].keyDown("a", false);
        const commit = (at, upTo) => message({ type: "commit", at, upTo, inputs: [] });
        const joinedAt = async (upTo) => {
            const session = await joining();
            session.deliver(snapshotMessages(100, [{ at: 100, upTo, inputs: [] }]));
            await vi.waitFor(() => expect(session.context.processor.restoreState).toHaveBeenCalledTimes(1));
            return session;
        };

        it("with nothing before it has a machine to stamp against", async () => {
            const { context, channel } = await joining();
            press(context);
            const [key] = sentKeys(channel);
            expect(key.at).toBeUndefined();
            expect(key.snapshots).toBe(0);
        });

        it("a round trip and a margin past where the host was when it last heard, and later as time passes", async () => {
            const { context, channel, deliver } = await joinedAt(100000);
            deliver([commit(100000, 100500)]);
            press(context);
            vi.advanceTimersByTime(30);
            press(context);
            const [first, second] = sentKeys(channel);
            expect(first).toMatchObject({ at: 100500 + (200 + 20) * MsCycles, snapshots: 1 });
            expect(second.at - first.at).toBe(30 * MsCycles);
        });

        it("coming down to a round trip that shrinks a little with each key, never squeezing a tap", async () => {
            const { context, channel, deliver, lockstep } = await joinedAt(100000);
            deliver([commit(100000, 100500)]);
            press(context);
            lockstep().execute(100);
            vi.advanceTimersByTime(StatsIntervalMs);
            lockstep().execute(100);
            await settle();
            deliver([commit(100500, 101000)]);
            press(context);
            vi.advanceTimersByTime(10);
            press(context);
            const [first, second, third] = sentKeys(channel).map((each) => each.at);
            expect(second - first).toBe(40 * MsCycles);
            expect(third - second).toBe(10 * MsCycles);
            vi.advanceTimersByTime(StatsIntervalMs);
            lockstep().execute(100);
            const summary = channel
                .messages()
                .filter((each) => each.type === "stats")
                .at(-1).stats;
            expect(summary.stampAheadMs).toBe(Math.round((third - 101000) / MsCycles));
        });

        it("and says in its summary how far ahead it stamps", async () => {
            const { context, channel, lockstep } = await joinedAt(100000);
            press(context);
            lockstep().execute(100);
            vi.advanceTimersByTime(StatsIntervalMs);
            lockstep().execute(100);
            const [summary] = channel.messages().filter((each) => each.type === "stats");
            expect(summary.stats.stampAheadMs).toBeGreaterThanOrEqual(200 + 20);
        });

        it("afresh after a resync, counting the snapshots it has restored", async () => {
            const { context, channel, deliver } = await joinedAt(100000);
            press(context);
            deliver(snapshotMessages(500, [{ at: 500, upTo: 600, inputs: [] }]));
            await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(2));
            deliver([commit(600, 700)]);
            press(context);
            const [, second] = sentKeys(channel);
            expect(second).toMatchObject({ at: 700 + (200 + 20) * MsCycles, snapshots: 2 });
        });
    });

    it("tells the host once a second how it kept up", async () => {
        const { context, channel, deliver, lockstep } = await joining();
        deliver(snapshotMessages(100, [{ at: 100, upTo: 150, inputs: [] }]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        lockstep().execute(100);
        vi.advanceTimersByTime(1000);
        lockstep().execute(100);
        const stats = channel.messages().filter((each) => each.type === "stats");
        expect(stats).toEqual([
            {
                type: "stats",
                stats: expect.objectContaining({ frames: 2, framesMaxGapMs: 1000, starved: 2, lagMs: 0 }),
            },
        ]);
    });

    it("opens the session pane once it has joined, and not again at a resync", async () => {
        showLights();
        const { context, deliver } = await joining();
        const pane = document.getElementById("session-pane");
        expect(pane.hidden).toBe(true);
        deliver(snapshotMessages(100, [{ at: 100, upTo: 100000, inputs: [] }]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        expect(pane.hidden).toBe(false);
        pane.querySelector(".session-pane-close").click();
        deliver(snapshotMessages(200, [{ at: 200, upTo: 100000, inputs: [] }]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(2));
        expect(pane.hidden).toBe(true);
    });

    it("measures its own round trip to the host, and shows and logs it", async () => {
        showLights();
        const { guest, context, channel, deliver, lockstep } = await joining();
        channel.emit("message", message({ type: "welcome", model: context.model.name, version: "1.0", name: "Matt" }));
        deliver(snapshotMessages(100, [{ at: 100, upTo: 100000, inputs: [] }]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        lockstep().execute(100);
        vi.advanceTimersByTime(StatsIntervalMs);
        lockstep().execute(100);
        await settle();
        lockstep().execute(100);
        vi.advanceTimersByTime(StatsIntervalMs);
        lockstep().execute(100);
        expect(document.querySelector("#session-panel .led").title).toMatch(/^Matt: .*, 85 ms round trip, /);
        expect(guest.report().events).toContainEqual(expect.objectContaining({ event: "connection", rttMs: 85 }));
    });

    it("does not count a frame as catching up when its lag is within a slice of the limit", async () => {
        const { context, channel, deliver, lockstep } = await joining();
        const justOverTheLimit = MaxGuestLagSeconds * CyclesPerSecond + 50;
        deliver(snapshotMessages(100, [{ at: 100, upTo: 100 + justOverTheLimit, inputs: [] }]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        lockstep().execute(100);
        vi.advanceTimersByTime(1000);
        lockstep().execute(100);
        const [{ stats }] = channel.messages().filter((each) => each.type === "stats");
        expect(stats.catchingUp).toBeUndefined();
    });

    it("counts a frame as catching up only when it starts far behind the host", async () => {
        const { context, channel, deliver, lockstep } = await joining();
        const farBehind = CyclesPerSecond;
        deliver(snapshotMessages(100, [{ at: 100, upTo: 100 + farBehind, inputs: [] }]));
        await vi.waitFor(() => expect(context.processor.restoreState).toHaveBeenCalledTimes(1));
        lockstep().execute(100);
        vi.advanceTimersByTime(1000);
        lockstep().execute(100);
        const [{ stats }] = channel.messages().filter((each) => each.type === "stats");
        expect(stats).toMatchObject({ catchingUp: 2 });
        expect(stats.starved).toBeUndefined();
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
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
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
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
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
        await vi.waitFor(() => {
            lockstep().execute(1000);
            expect(processor.currentCycles).toBe(600);
        });
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
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
        expect(context.urlState.urlWith).not.toHaveBeenCalled();
    });

    it("stays as it is when the host is the same machine", async () => {
        const { context, channel } = await joining();
        channel.emit("message", message({ type: "welcome", model: "B-DFS1.2", version: "1.0" }));
        expect(context.urlState.urlWith).not.toHaveBeenCalled();
        expect(context.loop.setLockstep).not.toHaveBeenLastCalledWith(null);
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

    it("copies the link to join from a guest's pane", async () => {
        showLights();
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        try {
            await started({ client: "there" });
            document.querySelector(".session-copy-link").dispatchEvent(new MouseEvent("click", { cancelable: true }));
            await settle();
            expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?client=there`);
        } finally {
            delete navigator.clipboard;
        }
    });

    it("shows the session in the lights, with its report to save", async () => {
        showLights();
        URL.createObjectURL = vi.fn(() => "blob:report");
        URL.revokeObjectURL = vi.fn();
        try {
            vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
            await started({ client: "there" });
            const panel = document.getElementById("session-panel");
            expect(panel.hidden).toBe(false);
            expect(document.getElementById("session-pane").hidden).toBe(true);
            expect(panel.querySelector(".led").dataset.state).toBe("connecting");
            expect(document.querySelector(".session-you").textContent).toMatch(/^You are [a-z]+-[a-z]+-[a-z]+$/);
            document.querySelector(".session-report").click();
            const report = JSON.parse(await URL.createObjectURL.mock.calls[0][0].text());
            expect(report).toMatchObject({ role: "guest", room: "there", version: "1.0" });
        } finally {
            delete URL.createObjectURL;
            delete URL.revokeObjectURL;
        }
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
