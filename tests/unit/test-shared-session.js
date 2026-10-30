// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    MinResyncIntervalMs,
    SessionFailures,
    SessionGuest,
    SessionHost,
    cleanName,
    hostSession,
    joinLink,
    roomFrom,
    sessionInput,
    startSessionFromUrl,
} from "../../src/web/shared-session.js";
import { RendezvousError } from "../../src/web/rendezvous-client.js";
import { snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { LockstepHost, MaxGuestLagSeconds, stateHash } from "../../src/lockstep.js";
import { AdcCentreValue } from "../../src/adc.js";
import { StatsIntervalMs } from "../../src/web/session-log.js";
import { ParamTypes, parseQueryString } from "../../src/url-params.js";
import { Parameters, urlParamType } from "../../src/web/parameters.js";
import { sentEvents } from "./helpers.js";
import { inProcessTransport } from "../helpers/session-link.js";
import {
    CyclesPerSecond,
    StockTakenFromHost,
    fakeKeyMapping,
    fakePage,
    fakeProcessor,
    plainCodec,
} from "../helpers/session-fakes.js";

const MsPerMinute = 60 * 1000;
const MsCycles = CyclesPerSecond / 1000;
const A = [4, 1];

// A codec that packs nothing until told to, as gzip takes its time.
function heldCodec() {
    const held = [];
    return {
        compress: (text) => new Promise((resolve) => held.push(() => resolve(plainCodec.compress(text)))),
        decompress: plainCodec.decompress,
        release: () => held.splice(0).forEach((pack) => pack()),
    };
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
    const up = (mapping) => ({ kind: "key", mapping, down: false });

    it.each([
        [
            "a key as its place on the matrix",
            false,
            (input) => input.keyDown("a", false),
            [{ kind: "key", mapping: A, down: true }],
        ],
        ["a key let go under its forced-SHIFT mapping", false, (input) => input.keyUp("@"), [up([4, 1, false])]],
        [
            "a key let go under each of its mappings, as the machine's own keyUp does",
            false,
            (input) => input.keyUp("a"),
            [up(A), up(A)],
        ],
        [
            "a pasted key as the place on the matrix it was given",
            false,
            (input) => input.keyRaw([0, 0], true),
            [{ kind: "key", mapping: [0, 0], down: true }],
        ],
        ["nothing for a key the layout does not have", false, (input) => input.keyDown("?", false), []],
        ["BREAK where it is allowed", true, (input) => input.setReset(true), [{ kind: "break", down: true }]],
        ["no BREAK where it is not", false, (input) => input.setReset(true), []],
    ])("sends %s", (_, allowBreak, act, expected) => {
        const inputs = [];
        act(sessionInput({ keyMapping: fakeKeyMapping }, (input) => inputs.push(input), { allowBreak }));
        expect(inputs).toEqual(expected);
    });
});

// A link whose other end the test plays: what the session sends on it is kept, and what the test emits reaches the
// session at once.
class FakeLink {
    constructor({ open = true } = {}) {
        this.listener = null;
        this.sent = [];
        this.full = false;
        this.open = open;
        this.closed = false;
    }

    send(data) {
        if (!this.isOpen()) throw new Error("the channel is not open");
        if (this.full) throw new Error("send queue is full");
        this.sent.push(data);
    }

    isOpen() {
        return this.open && !this.closed;
    }

    close() {
        this.closed = true;
    }

    async stats() {
        return { rttMs: 85, route: "srflx/srflx" };
    }

    emit(type, event) {
        if (type === "message") this.listener.message(event.data);
        else this.listener.closed("its channel closed");
    }

    messages(type) {
        const messages = this.sent.filter((data) => typeof data === "string").map((data) => JSON.parse(data));
        return type === undefined ? messages : messages.filter((each) => each.type === type);
    }

    // Each snapshot here fits one chunk.
    snapshots() {
        const snapshots = [];
        let expecting = false;
        for (const data of this.sent) {
            if (typeof data === "string") {
                expecting = JSON.parse(data).type === "snapshot";
            } else if (expecting) {
                snapshots.push(snapshotFromJSON(new TextDecoder().decode(data)));
                expecting = false;
            }
        }
        return snapshots;
    }
}

// A transport whose other ends are the test's: a host's guests arrive as the test offers them, and a guest's join
// gives it a link at once.
function fakeTransport(overrides = {}) {
    const fake = {
        links: [],
        host: null,
        listening: false,
        createRoom: vi.fn(async () => "secret"),
        listen: vi.fn((room, secret, host) => {
            fake.host = host;
            fake.listening = true;
            return { close: () => (fake.listening = false) };
        }),
        join: vi.fn(async (room, id, listener) => {
            listener.offered();
            listener.answered();
            const link = new FakeLink();
            link.listener = listener;
            fake.links.push(link);
            return link;
        }),
        /** A guest of `id` connecting to the host, its link not yet open. */
        offer(id) {
            const link = new FakeLink({ open: false });
            link.listener = fake.host.connecting(id, link);
            fake.links.push(link);
            return link;
        },
        ...overrides,
    };
    return fake;
}

const TakenFromHostNames = Object.keys(Parameters).filter((name) => Parameters[name].takenFromHost);
const welcomeAs = (fields) => ({
    type: "welcome",
    model: "B-DFS1.2",
    version: "1.0",
    takenFromHost: StockTakenFromHost,
    ...fields,
});

function fakeContext({
    processor = fakeProcessor(),
    transport: sessionTransport = transport,
    model = {},
    takenFromHost = StockTakenFromHost,
    codec = plainCodec,
    page: sessionPage = page,
} = {}) {
    return {
        processor,
        model: { name: "BBC B with 8271 (DFS 1.2)", cyclesPerSecond: CyclesPerSecond, ...model },
        takenFromHost,
        loop: { setLockstep: vi.fn(), replacingState: vi.fn() },
        keyboard: { isPasting: false, setInput: vi.fn(), cancelPaste: vi.fn() },
        version: "1.0",
        transport: sessionTransport,
        codec,
        page: sessionPage,
    };
}

let page;
let transport;
const settle = () => vi.advanceTimersByTimeAsync(0);
const panel = () => page.panels.at(-1);
const desyncNotices = () => page.notices.filter((text) => text.includes("desync"));
const message = (body) => ({ data: JSON.stringify(body) });
const events = (session, type) => session.report().events.filter((each) => each.event === type);
// The second the session clock shows: wall time here, read as UTC.
const wallClockSecondMs = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * MsPerMinute) / 1000) * 1000;

let hosts;
let guests;

beforeEach(() => {
    page = fakePage();
    transport = fakeTransport();
    hosts = [];
    guests = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
    for (const host of hosts) host.close();
    for (const guest of guests) guest.leave();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("SessionHost", () => {
    async function hosting({ codec = plainCodec } = {}) {
        const processor = fakeProcessor();
        const context = fakeContext({ processor, codec });
        const host = new SessionHost(context, "room");
        hosts.push(host);
        await host.start();
        return { host, processor, context };
    }

    function connect(name) {
        const channel = transport.offer(`g${transport.links.length + 1}`);
        channel.open = true;
        channel.emit("message", message({ type: "hello", name }));
        return channel;
    }

    async function joined(name) {
        const channel = connect(name);
        await settle();
        return channel;
    }

    const keyMessage = (input) => message({ type: "input", input });

    it("notes being created, each guest connecting with how many are, and ending with how many joined", async () => {
        const sent = sentEvents();
        const { host } = await hosting();
        connect();
        await settle();
        connect();
        await settle();
        const never = transport.offer("never");
        never.emit("close");
        host.close();
        expect(never.closed).toBe(true);
        expect(sent("session")).toEqual([
            { role: "host", stage: "created" },
            { role: "host", stage: "connected", peers: "1" },
            { role: "host", stage: "connected", peers: "2" },
            { role: "host", stage: "ended", reason: "page_closed", peers: "2" },
        ]);
    });

    it("closes as its page goes, and stops listening for that once it has closed", async () => {
        const { host, context } = await hosting();
        const [{ signal }] = page.hideListeners;
        page.hide();
        expect(host.closed).toBe(true);
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
        expect(signal.aborted).toBe(true);
    });

    it("holds the analogue inputs at the centre for the session, and gives back an ordinary page when it closes", async () => {
        const { host, processor, context } = await hosting();
        expect(processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(AdcCentreValue);
        host.close();
        expect(processor.adconverter.setFixedValue).toHaveBeenLastCalledWith(null);
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
        expect(context.keyboard.setInput).toHaveBeenLastCalledWith(null);
        expect(processor.sysvia.cmos.bbcDateTime()).toBeInstanceOf(Date);
    });

    it("says and logs when its room had expired and is open again, or has gone for good", async () => {
        const { host } = await hosting();
        transport.host.reopened();
        transport.host.gone(new Error("Room already exists"));
        expect(page.notices.slice(-2)).toEqual([
            `The room "room" had expired, and is open again.`,
            `The room "room" has gone, so nobody else can join: Room already exists`,
        ]);
        expect(host.report().events.map(({ event }) => event)).toEqual(
            expect.arrayContaining(["room reopened", "room gone"]),
        );
    });

    it("listens on its room until it closes", async () => {
        const { host } = await hosting();
        expect(transport.listen).toHaveBeenCalledWith("room", "secret", expect.any(Object));
        expect(transport.listening).toBe(true);
        host.close();
        expect(transport.listening).toBe(false);
    });

    it("welcomes a guest with its model, the settings a guest takes from it, its version and name, then sends the machine", async () => {
        const { host } = await hosting();
        const channel = await joined();
        expect(channel.messages()[0]).toEqual({
            type: "welcome",
            model: "BBC B with 8271 (DFS 1.2)",
            takenFromHost: StockTakenFromHost,
            version: "1.0",
            name: host.name,
        });
        expect(channel.snapshots()[0].at).toBe(1000);
    });

    it("sends a joiner the commits made while its snapshot was compressed, after it", async () => {
        const codec = heldCodec();
        const { host } = await hosting({ codec });
        const channel = connect();
        await settle();
        host.execute(100);
        host.execute(100);
        codec.release();
        await settle();
        expect(channel.snapshots()).toHaveLength(1);
        const commits = channel.messages("commit");
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

    describe("control", () => {
        const keyA = { kind: "key", mapping: A, down: true };
        async function twoGuests() {
            const { host, processor } = await hosting();
            const first = connect();
            const second = connect();
            await settle();
            return { host, processor, first, second };
        }
        const commit = (at, upTo, inputs = []) => message({ type: "commit", at, upTo, inputs });
        const lastControl = (host) => events(host, "control").at(-1);

        it("passes to a guest that asks, from where the machine is, with the keys still waiting for it", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "input", input: keyA, at: 1000 + 50 * MsCycles, snapshots: 1 }));
            channel.emit("message", message({ type: "take" }));
            expect(channel.messages("handover")).toEqual([{ type: "handover", at: 1000 }]);
            expect(channel.messages("input")).toEqual([
                { type: "input", input: keyA, at: 1000 + 50 * MsCycles, source: "g1" },
            ]);
            expect(host.report().events).toContainEqual(expect.objectContaining({ event: "control", guest: "g1" }));
        });

        it("lists the host first in its own pane, marked while it is in control", async () => {
            const { host } = await hosting();
            const channel = await joined();
            const MsCycles = CyclesPerSecond / 1000;
            const self = () => panel().peers[0];
            host.showStatus();
            expect(self()).toMatchObject({ label: `${host.name} (you)`, control: true });
            channel.emit("message", message({ type: "take" }));
            channel.emit("message", message({ type: "commit", at: 1000, upTo: 1000 + 300 * MsCycles, inputs: [] }));
            host.showStatus();
            expect(self()).toEqual({ label: `${host.name} (you)`, state: "lagging", lagMs: 300, control: false });
            expect(panel().who).toBe("Guest 1");
            host.requestControl(null);
            channel.emit("message", message({ type: "released", at: 1000 + 300 * MsCycles, waiting: [] }));
            host.showStatus();
            expect(self()).toMatchObject({ control: true });
            host.execute(400 * MsCycles);
            host.showStatus();
            expect(self()).toEqual({ label: `${host.name} (you)`, state: "ok", lagMs: undefined, control: true });
            expect(panel().who).toBe("you");
        });

        it("tells every guest whether a key press takes control as its option is set, and one joining after", async () => {
            await hosting();
            const first = await joined();
            expect(first.messages("roster").at(-1)).toMatchObject({ takeOnKey: false });
            panel().setTakeOnKey(true);
            expect(first.messages("roster").at(-1)).toMatchObject({ takeOnKey: true });
            const second = await joined();
            expect(second.messages("roster")[0]).toMatchObject({ takeOnKey: true });
        });

        it("passes on a key pressed to take it, as well as the key", async () => {
            await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "input", input: keyA, take: true }));
            expect(channel.messages("handover")).toHaveLength(1);
        });

        it("sends this page's keys to the guest in control, stamped", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "take" }));
            host.input(keyA);
            const [sent] = channel.messages("input");
            expect(sent).toMatchObject({ input: keyA, source: "host" });
            expect(sent.at).toBeGreaterThan(1000);
        });

        it("comes back to the host from the end of the last commit when the guest in control leaves", async () => {
            const { host, processor, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            first.emit("message", message({ type: "bye" }));
            host.execute(5000);
            host.execute(100);
            expect(processor.currentCycles).toBe(3100);
            expect(second.messages("commit").at(-1)).toMatchObject({ at: 3000, upTo: 3100 });
            expect(second.snapshots()).toHaveLength(1);
        });

        it("goes from one guest to another through the first stopping", async () => {
            const { first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            second.emit("message", message({ type: "take" }));
            expect(first.messages("release")).toHaveLength(1);
            expect(second.messages("handover")).toEqual([]);
            first.emit(
                "message",
                message({ type: "released", at: 3000, waiting: [{ source: "g2", input: keyA, at: 4000 }] }),
            );
            expect(second.messages("handover")).toEqual([{ type: "handover", at: 3000 }]);
            expect(second.messages("input")).toEqual([{ type: "input", input: keyA, at: 4000, source: "g2" }]);
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
            expect(channel.messages("input")).toEqual([]);
        });

        it.each([
            ["no commit carried", []],
            ["a commit carried", [keyA]],
        ])("applies a key it sent the guest in control once when %s it before that guest left", async (_, inputs) => {
            const { host, processor, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            host.input(keyA);
            first.emit("message", commit(1000, 3000, inputs));
            first.emit("message", message({ type: "bye" }));
            host.execute(5000);
            host.execute(CyclesPerSecond);
            expect(processor.sysvia.setMapped.mock.calls.filter(([, down]) => down === 1)).toEqual([[A, 1]]);
        });

        const keyAUp = { kind: "key", mapping: A, down: false };
        const keyB = { kind: "key", mapping: [5, 2], down: true };

        it.each([
            [
                "the host presses BREAK",
                true,
                ({ host, release }) => {
                    release(3000);
                    host.input({ kind: "break", down: true });
                },
            ],
            [
                "the host's machine jumps",
                true,
                ({ host, processor, release }) => {
                    release(3000);
                    processor.currentCycles = processor.targetCycles = 50;
                    host.execute(100);
                },
            ],
            [
                "the host's replay disagrees with the guest in control",
                true,
                ({ host, first, release }) => {
                    first.emit("message", message({ type: "commit", at: 3000, upTo: 5000, inputs: [], hash: "nope" }));
                    release(5000);
                    host.execute(5000);
                },
            ],
            [
                "the guest in control goes quiet",
                false,
                ({ host, release }) => {
                    release(3000);
                    vi.advanceTimersByTime(3001);
                    host.execute(100);
                    host.execute(5000);
                },
            ],
            [
                "the guest in control sends a commit that does not follow on",
                true,
                ({ first, release }) => {
                    release(3000);
                    first.emit("message", commit(1500, 3000));
                },
            ],
            [
                "the guest in control sends a commit with BREAK in it",
                true,
                ({ first, release }) => {
                    release(3000);
                    first.emit("message", commit(5000, 7000, [{ kind: "break", down: true }]));
                },
            ],
        ])("comes back to the host when %s, with every key it had not applied", async (_, everyone, happen) => {
            const { host, processor, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000, [keyA]));
            host.execute(5000);
            host.input(keyB);
            const release = (at) => first.emit("message", commit(at, at + 2000, [keyAUp]));
            happen({ host, processor, first, release });
            await settle();
            expect(first.snapshots().length).toBeGreaterThan(1);
            expect(second.snapshots()).toHaveLength(everyone ? 2 : 1);
            expect(lastControl(host)).toMatchObject({ guest: "host" });
            const before = second.messages("commit").length;
            host.execute(CyclesPerSecond);
            await settle();
            expect(second.messages("commit").length).toBeGreaterThan(before);
            expect(processor.sysvia.setMapped.mock.calls).toContainEqual([A, 0]);
            expect(processor.sysvia.setMapped.mock.calls).toContainEqual([keyB.mapping, 1]);
        });

        it("says once that its replay desynced from the guest in control, and logs both hashes", async () => {
            const { host, processor, first } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            const before = page.notices.length;
            first.emit("message", message({ type: "commit", at: 1000, upTo: 3000, inputs: [], hash: "nope" }));
            host.execute(5000);
            expect(page.notices.slice(before)).toEqual([
                "This machine desynced from Guest 1, which was in control, and took control back: state differs at " +
                    "cycle 3000. Resyncing; please save a session report.",
            ]);
            expect(events(host, "desync")[0]).toEqual({
                ms: expect.any(Number),
                event: "desync",
                guest: "g1",
                reason: "state differs at cycle 3000",
                cycle: 3000,
                at: 1000,
                upTo: 3000,
                expectedHash: "nope",
                hash: stateHash(processor),
            });
        });

        it.each([
            ["while a guest is in control", (first) => first.emit("message", message({ type: "take" }))],
            ["while it is in control", () => {}],
        ])("does not count its own machine jumping %s as a desync", async (_, before) => {
            const { host, processor, first } = await twoGuests();
            before(first);
            processor.currentCycles = processor.targetCycles = 50;
            host.execute(100);
            await settle();
            expect(first.snapshots()).toHaveLength(2);
            expect(events(host, "desync")).toEqual([]);
            expect(desyncNotices()).toEqual([]);
            first.emit("message", message({ type: "resync", reason: "state differs" }));
            expect(desyncNotices()).toEqual([
                "Guest 1 desynced: state differs. Resyncing; please save a session report.",
            ]);
        });

        it.each([
            [
                "keeps the session's clock when its replay disagrees",
                true,
                ({ host, first }) => {
                    vi.advanceTimersByTime(60000);
                    first.emit("message", message({ type: "commit", at: 1000, upTo: 3000, inputs: [], hash: "nope" }));
                    host.execute(5000);
                },
            ],
            [
                "starts the session's clock afresh when its machine jumps",
                false,
                ({ host, processor }) => {
                    processor.currentCycles = processor.targetCycles = 50;
                    host.execute(100);
                },
            ],
        ])("%s while a guest is in control", async (_, keepsClock, happen) => {
            const session = await twoGuests();
            const [before] = session.first.snapshots();
            session.first.emit("message", message({ type: "take" }));
            happen(session);
            await settle();
            expect(session.first.snapshots()).toHaveLength(2);
            const after = session.first.snapshots()[1].rtcBaseMs;
            if (keepsClock) expect(after).toBe(before.rtcBaseMs);
            else expect(after).not.toBe(before.rtcBaseMs);
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
            expect(lastControl(host)).toMatchObject({ guest: "g1" });
        });

        it("hands a guest whose snapshot is still on its way control once it has it", async () => {
            const { host, first } = await twoGuests();
            host.resyncEveryone();
            first.emit("message", message({ type: "take" }));
            expect(first.messages("handover")).toEqual([]);
            await settle();
            expect(first.snapshots()).toHaveLength(2);
            expect(first.messages("handover")).toHaveLength(1);
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
            expect(first.messages("release")).toEqual([]);
            await settle();
            expect(second.snapshots()).toHaveLength(2);
            expect(first.messages("release")).toHaveLength(1);
        });

        it("hands control to a guest that asked while the host was taking it back, once it has", async () => {
            const { host, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            first.emit("message", message({ type: "bye" }));
            second.emit("message", message({ type: "take" }));
            expect(second.messages("handover")).toEqual([]);
            host.execute(5000);
            expect(second.messages("handover")).toEqual([{ type: "handover", at: 3000 }]);
        });

        it("forgets a guest that asked for control and then left", async () => {
            const { host, first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            second.emit("message", message({ type: "take" }));
            second.emit("message", message({ type: "bye" }));
            first.emit("message", message({ type: "released", at: 3000, waiting: [] }));
            host.execute(5000);
            expect(lastControl(host)).toMatchObject({ guest: "host" });
        });

        it("takes control back at once if the guest in control stops anywhere but the end of its last commit", async () => {
            const { first, second } = await twoGuests();
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            second.emit("message", message({ type: "take" }));
            first.emit("message", message({ type: "released", at: 2500, waiting: [] }));
            await settle();
            expect(second.snapshots()).toHaveLength(2);
        });

        it("does not pass the guest in control its own keys back", async () => {
            await hosting();
            const channel = await joined();
            channel.emit("message", message({ type: "take" }));
            channel.emit("message", message({ type: "input", input: keyA, own: true }));
            expect(channel.messages("input")).toEqual([]);
        });

        it("keeps a key it pressed to take control back down long enough when it is let go just after control came", async () => {
            const { host, first, second } = await twoGuests();
            host.setTakeOnKey(true);
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            host.input(keyA);
            first.emit("message", message({ type: "released", at: 3000, waiting: [] }));
            vi.advanceTimersByTime(60);
            host.execute(5000);
            host.execute(100);
            host.input(keyAUp);
            host.execute(CyclesPerSecond);
            const keys = second.messages("commit").flatMap(({ at, inputs }) => inputs.map(({ down }) => [down, at]));
            expect(keys[0]).toEqual([true, 3000]);
            expect(keys[1][1] - 3000).toBeGreaterThanOrEqual(40 * MsCycles);
        });

        it("puts BREAK in at once, ahead of keys of its own still waiting", async () => {
            const { host, first, second } = await twoGuests();
            host.setTakeOnKey(true);
            first.emit("message", message({ type: "take" }));
            first.emit("message", commit(1000, 3000));
            host.input(keyA);
            vi.advanceTimersByTime(84);
            host.input(keyAUp);
            first.emit("message", message({ type: "released", at: 3000, waiting: [] }));
            host.execute(5000);
            host.input({ kind: "break", down: true });
            host.execute(100);
            host.execute(CyclesPerSecond);
            const keys = second
                .messages("commit")
                .flatMap(({ at, inputs }) => inputs.map(({ kind, down }) => [kind, down, at]));
            expect(keys).toEqual([
                ["key", true, 3000],
                ["break", true, 3000],
                ["key", false, 3000 + 40 * MsCycles],
            ]);
        });

        it("puts in at once two keys this page presses together, as a machine of its own would", async () => {
            const { host, second } = await twoGuests();
            host.input(keyA);
            vi.advanceTimersByTime(5);
            host.input({ kind: "key", mapping: [0, 0], down: true });
            host.execute(100);
            const [commitOf] = second.messages("commit").filter(({ inputs }) => inputs.length > 0);
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
            await settle();
            expect(second.snapshots()).toHaveLength(2);
            const [snapshot] = second.snapshots().slice(-1);
            const after = second.messages().slice(second.messages().findLastIndex((each) => each.type === "snapshot"));
            const commits = after.filter((each) => each.type === "commit");
            expect(commits[0].at).toBe(snapshot.at);
            expect(commits.at(-1)).toMatchObject({ upTo: 5000 });
        });
    });

    describe("a guest's keys", () => {
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
        const appliedMs = (channel) =>
            channel
                .messages()
                .filter((each) => each.type === "commit" && each.inputs.length > 0)
                .flatMap((each) =>
                    each.inputs.map((input) => [input.mapping.join(), input.down, (each.at - 1000) / MsCycles]),
                );
        const run = (host, count, ms) => {
            for (let i = 0; i < count; ++i) host.execute(ms * MsCycles);
        };

        it("go in at the cycle they were stamped with, and are logged with it", async () => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", stamped(true, 10));
            run(host, 1, 20);
            expect(appliedMs(channel)).toEqual([["4,1", true, 10]]);
            expect(host.report().events).toContainEqual(
                expect.objectContaining({ event: "input", guest: "g1", stamp: 1000 + 10 * MsCycles }),
            );
        });

        it("stamped after the host restarted its machine go in on their own cycles", async () => {
            const { host, processor } = await hosting();
            const channel = await joined();
            run(host, 1, 300);
            channel.emit("message", stamped(true, 290));
            run(host, 1, 20);
            processor.currentCycles = processor.targetCycles = 1000;
            run(host, 1, 0);
            await settle();
            expect(channel.snapshots()).toHaveLength(2);
            channel.emit("message", stamped(false, 30, A, { snapshots: 2 }));
            run(host, 3, 20);
            expect(appliedMs(channel).at(-1)).toEqual(["4,1", false, 30]);
        });

        it.each([
            ["stamped before the guest's latest snapshot", stamped(true, 30, A, { snapshots: 0 })],
            ["with a stamp that is not a cycle", stamped(true, 30, A, { at: 1000.5 })],
        ])("%s go in at once", async (_, input) => {
            const { host } = await hosting();
            const channel = await joined();
            channel.emit("message", input);
            run(host, 1, 0);
            expect(appliedMs(channel)).toEqual([["4,1", true, 0]]);
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
            expect(events(host, "input").map(({ down, cycle }) => [down, cycle])).toEqual([
                [true, 1000 + 10 * MsCycles],
                [false, 1000 + 20 * MsCycles],
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
        expect(channel.closed).toBe(true);
        expect(host.report().events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ event: "input", guest: "g1", mapping: [4, 1], down: true, guestMs: 12.5 }),
                expect.objectContaining({ event: "left", guest: "g1", reason: "it said goodbye" }),
            ]),
        );
        expect(events(host, "input").map((each) => each.cycle)).toEqual([1000, 1000]);
    });

    it("logs how long a snapshot took to take and to send, and watches the page while it hosts", async () => {
        const { host } = await hosting();
        await joined();
        const [snapshot] = events(host, "snapshot");
        expect(snapshot).toMatchObject({ takeMs: expect.any(Number), tookMs: expect.any(Number) });
        expect(snapshot.takeMs).toBeLessThanOrEqual(snapshot.tookMs);
        expect(page.watching).toBe(host.log);
        host.close();
        expect(page.watching).toBeNull();
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
        const logged = events(host, "guest stats")[0];
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
        const channel = await joined("Kieran");
        channel.emit("message", message({ type: "hello", name: "Matt (you)" }));
        await settle();
        expect(channel.messages("welcome")).toHaveLength(1);
        expect(channel.snapshots()).toHaveLength(1);
        for (let i = 0; i < 3; ++i) channel.emit("message", message({ type: "stats", stats: { lagMs: i } }));
        vi.advanceTimersByTime(StatsIntervalMs);
        channel.emit("message", message({ type: "stats", stats: { lagMs: 9 } }));
        expect(events(host, "hello").map((each) => each.name)).toEqual(["Kieran"]);
        expect(events(host, "guest stats").map(({ lagMs, dropped }) => [lagMs, dropped])).toEqual([
            [0, 0],
            [9, 2],
        ]);
    });

    it("sends each guest the lights once an interval, and logs and shows each connection's round trip", async () => {
        const { host } = await hosting();
        const channel = await joined();
        channel.emit("message", message({ type: "stats", stats: { lagMs: 30, commits: 50 } }));
        const rosters = () => channel.messages("roster").length;
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
        expect(panel().peers[1]).toMatchObject({ label: "Guest 1", state: "ok", rttMs: 85, lagMs: 30 });
    });

    it("shows each guest's light, and keeps a departed one's for a while", async () => {
        const { host } = await hosting();
        const channel = await joined();
        const lights = () =>
            panel()
                .peers.slice(1)
                .map((peer) => peer.state);
        expect(lights()).toEqual(["connecting"]);
        channel.emit("message", message({ type: "stats", stats: { lagMs: 30, commits: 50 } }));
        vi.advanceTimersByTime(StatsIntervalMs);
        host.execute(0);
        expect(lights()).toEqual(["ok"]);
        expect(panel().summary).toBe("1 guest");
        channel.emit("message", message({ type: "bye" }));
        expect(lights()).toEqual(["left"]);
        expect(panel().summary).toBe("0 guests");
        vi.advanceTimersByTime(60000);
        host.execute(0);
        expect(lights()).toEqual([]);
    });

    it("shows every guest the same lights, its own marked", async () => {
        const { host } = await hosting();
        const first = connect("Kieran");
        const second = connect("Ana");
        await settle();
        expect(second.snapshots()).toHaveLength(1);
        const lastRoster = (channel) => channel.messages("roster").at(-1).guests;
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

    it("says when a guest desyncs and why, once however often it asks, and plainly that a second is a bug", async () => {
        await hosting();
        const first = connect();
        const second = connect();
        await settle();
        expect(second.snapshots()).toHaveLength(1);
        for (let i = 0; i < 3; ++i) first.emit("message", message({ type: "resync", reason: "state differs" }));
        second.emit("message", message({ type: "resync", reason: "it moved" }));
        expect(desyncNotices()).toEqual([
            "Guest 1 desynced: state differs. Resyncing; please save a session report.",
            "Another desync. Guest 2 desynced: it moved. More than one in a session is a bug: " +
                "please save a session report here and on Guest 2's machine, and send both with a bug report.",
        ]);
    });

    it("shows a guest that desynced as such until its next summary", async () => {
        const { host } = await hosting();
        const channel = await joined();
        const light = () => panel().peers[1].state;
        channel.emit("message", message({ type: "stats", stats: { lagMs: 30, commits: 50, desyncs: 1 } }));
        vi.advanceTimersByTime(StatsIntervalMs);
        host.execute(0);
        expect(light()).toBe("desynced");
        expect(events(host, "guest stats")[0]).toMatchObject({ desyncs: 1 });
        channel.emit("message", message({ type: "stats", stats: { lagMs: 30, commits: 50 } }));
        vi.advanceTimersByTime(StatsIntervalMs);
        host.execute(0);
        expect(light()).toBe("ok");
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
        expect(channel.closed).toBe(true);
    });

    it("sends a guest that keeps asking at most one snapshot per interval, logging only the asks it honours", async () => {
        const { host } = await hosting();
        const channel = await joined();
        for (let i = 0; i < 3; ++i) channel.emit("message", message({ type: "resync" }));
        await settle();
        expect(channel.snapshots()).toHaveLength(1);
        expect(events(host, "resync asked")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(MinResyncIntervalMs);
        await settle();
        expect(channel.snapshots()).toHaveLength(2);
    });

    it("sends a guest nothing, even at a jump, until it has said hello, then welcomes it with the machine as it is", async () => {
        const { host, processor } = await hosting();
        const opening = transport.offer("g1");
        opening.open = true;
        processor.currentCycles = processor.targetCycles = 50;
        host.execute(0);
        await settle();
        expect(opening.sent).toEqual([]);
        expect(opening.closed).toBe(false);
        opening.emit("message", message({ type: "hello", name: "Kieran" }));
        await settle();
        expect(opening.messages()[0]).toMatchObject({ type: "welcome" });
        expect(opening.snapshots().map((snapshot) => snapshot.at)).toEqual([50]);
    });

    it("sends a guest whose snapshot is still on its way the machine from after a jump instead", async () => {
        const codec = heldCodec();
        const { host, processor } = await hosting({ codec });
        const channel = connect();
        await settle();
        expect(channel.messages()[0]).toMatchObject({ type: "welcome" });
        processor.currentCycles = processor.targetCycles = 50;
        host.execute(0);
        codec.release();
        await settle();
        expect(channel.snapshots().map((snapshot) => snapshot.at)).toEqual([50]);
    });

    it("starts the clock from the wall time here", async () => {
        const { processor } = await hosting();
        expect(processor.sysvia.cmos.bbcDateTime().getTime()).toBe(wallClockSecondMs());
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
        const bytes = new TextEncoder().encode(snapshotToJSON(snapshot));
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

    async function joining(contextOptions) {
        const context = fakeContext(contextOptions);
        const guest = new SessionGuest(context, "room");
        guests.push(guest);
        await guest.start();
        const channel = context.transport.links[0];
        const deliver = async (messages) => {
            messages.forEach((each) => channel.emit("message", each));
            await settle();
        };
        const lockstep = () => context.loop.setLockstep.mock.calls.at(-1)[0];
        const keyboard = () => context.keyboard.setInput.mock.calls.at(-1)[0];
        return { guest, context, channel, deliver, lockstep, keyboard };
    }

    async function joinedAt(upTo) {
        const session = await joining();
        await session.deliver(snapshotMessages(100, [{ at: 100, upTo, inputs: [] }]));
        return session;
    }

    const firstSummary = (channel) => channel.messages("stats")[0].stats;

    it("shows the host's list of guests, its own marked, and makes the most of a bad one", async () => {
        const { channel } = await joining();
        const guests = [
            { label: "Kieran", state: "ok", rttMs: 85, lagMs: 60, you: true },
            { label: "\u0007", state: "on fire", rttMs: "fast" },
        ];
        channel.emit("message", message({ type: "roster", guests }));
        expect(panel().peers.map(({ label, state, rttMs, lagMs }) => [label, state, rttMs, lagMs])).toEqual([
            ["Host", "connecting", undefined, undefined],
            ["Kieran (you)", "ok", 85, 60],
            ["Guest", "silent", undefined, undefined],
        ]);
    });

    it("logs the inputs the host applied, with their cycle, and no lag once it has left", async () => {
        const { guest, channel, deliver } = await joining();
        const input = { kind: "key", mapping: [4, 1], down: true };
        await deliver(snapshotMessages(100, [{ at: 100, upTo: 150, inputs: [{ ...input, junk: "x".repeat(1000) }] }]));
        expect(guest.report().events).toContainEqual(
            expect.objectContaining({ event: "inputs", cycle: 100, inputs: [input] }),
        );
        channel.emit("close");
        expect(guest.report().lagMs).toBeUndefined();
    });

    it("sends the host each key with the time it was pressed here, but never BREAK", async () => {
        const { channel, keyboard } = await joining();
        vi.advanceTimersByTime(250);
        keyboard().keyDown("a", false);
        keyboard().setReset(true);
        const inputs = channel.messages("input");
        expect(inputs.map((each) => each.input.kind)).toEqual(["key"]);
        expect(inputs[0].ms).toBeGreaterThanOrEqual(250);
    });

    it("asks for control with a key press when the host has set it to, and shows the host's setting", async () => {
        const { channel, deliver, keyboard } = await joining();
        keyboard().keyDown("a", false);
        await deliver([message({ type: "roster", guests: [], takeOnKey: true })]);
        keyboard().keyDown("a", false);
        const sent = channel.messages("input");
        expect(sent.map(({ take }) => take)).toEqual([false, true]);
        expect(panel().takeOnKey).toBe(true);
        expect(panel().setTakeOnKey).toBeUndefined();
    });

    describe("analytics", () => {
        let sent;

        beforeEach(() => {
            sent = sentEvents();
        });

        afterEach(() => {
            for (const { reason } of sent("session").filter(({ reason }) => reason !== undefined))
                expect(Object.values(SessionFailures)).toContain(reason);
        });

        it("notes being created, connecting and the host leaving", async () => {
            const { channel } = await joining();
            channel.emit("close");
            expect(sent("session")).toEqual([
                { role: "guest", stage: "created" },
                { role: "guest", stage: "connected" },
                { role: "guest", stage: "ended", reason: "host_left" },
            ]);
        });

        it("notes its own page closing as the end, once", async () => {
            const { channel } = await joining();
            page.hide();
            expect(sent("session").filter(({ reason }) => reason === "page_closed")).toEqual([
                { role: "guest", stage: "ended", reason: "page_closed" },
            ]);
            expect(channel.messages("bye")).toHaveLength(1);
        });

        it("stops listening for its page going once it has left", async () => {
            const { channel } = await joining();
            const [{ signal }] = page.hideListeners;
            expect(signal.aborted).toBe(false);
            channel.emit("close");
            expect(signal.aborted).toBe(true);
        });

        it("notes failing to restore the host's machine", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const { deliver } = await joining();
            const junk = new Uint8Array([1, 2, 3]);
            await deliver([message({ type: "snapshot", bytes: junk.length }), { data: junk.buffer }]);
            expect(sent("session").at(-1)).toEqual({ role: "guest", stage: "failed", reason: "restore_failed" });
        });

        it("notes a host that never answers as a timeout", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const timedOut = Object.assign(new Error("the host isn't answering"), { sessionFailure: "timeout" });
            const join = vi.fn(async () => Promise.reject(timedOut));
            startSessionFromUrl({ client: "there" }, fakeContext({ transport: fakeTransport({ join }) }));
            await settle();
            expect(sent("session")).toEqual([
                { role: "guest", stage: "created" },
                { role: "guest", stage: "failed", reason: "timeout" },
            ]);
        });
    });

    describe("in control", () => {
        const commitsSent = (channel) => channel.messages("commit");
        async function inControl() {
            const session = await joinedAt(1000);
            await session.deliver([message({ type: "handover", at: 1000 })]);
            session.lockstep().execute(2000);
            return session;
        }

        it("applies the keys the host passes on at their stamps", async () => {
            const { channel, deliver, lockstep } = await inControl();
            await deliver([
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
            await deliver([message({ type: "input", input: later, at: 100000, source: "host" })]);
            await deliver([message({ type: "release" })]);
            expect(channel.messages().find((each) => each.type === "released")).toEqual({
                type: "released",
                at: 1500,
                waiting: [{ source: "host", input: later, at: 100000 }],
            });
            lockstep().execute(500);
            expect(commitsSent(channel)).toHaveLength(1);
        });

        it("keeps the keys passed on before it has reached the cycle it takes control at", async () => {
            const session = await joinedAt(1000);
            await session.deliver([
                message({ type: "handover", at: 1000 }),
                message({ type: "input", input: { kind: "key", mapping: A, down: true }, at: 1200, source: "g2" }),
            ]);
            session.lockstep().execute(2000);
            session.lockstep().execute(500);
            expect(commitsSent(session.channel).some(({ inputs }) => inputs.length === 1)).toBe(true);
        });

        it("asked to stop before it has taken control, gives it up at the cycle it was to take it at", async () => {
            const session = await joinedAt(1000);
            const key = { kind: "key", mapping: A, down: false };
            await session.deliver([
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
            const summary = channel.messages("stats").at(-1).stats;
            expect(summary.commits).toBeGreaterThan(0);
        });

        it.each([
            [
                "waiting quietly for the snapshot that ends its control",
                async ({ deliver }) => {
                    const [header] = snapshotMessages(5000, [{ at: 5000, upTo: 6000, inputs: [] }]);
                    await deliver([header]);
                },
            ],
            [
                "after it stops",
                async ({ deliver, lockstep }) => {
                    await deliver([message({ type: "release" })]);
                    lockstep().execute(500);
                },
            ],
        ])("asks for no resync %s", async (_, happen) => {
            const session = await inControl();
            session.lockstep().execute(500);
            await happen(session);
            session.lockstep().execute(500);
            expect(session.channel.messages("resync")).toEqual([]);
        });

        it("greys out its Take control button while control is on its way to it", async () => {
            const session = await joinedAt(1000);
            await session.deliver([message({ type: "roster", guests: [] })]);
            expect(panel().canTake).toBe(true);
            await session.deliver([message({ type: "handover", at: 5000 }), message({ type: "roster", guests: [] })]);
            expect(panel().canTake).toBe(false);
        });

        it("does not let a quick re-tap land with the release of a key that took control late", async () => {
            const session = await joinedAt(1000);
            const keyboard = session.keyboard();
            keyboard.keyDown("a", false);
            const [press] = session.channel.messages("input");
            const handoverAt = press.at + 30 * MsCycles;
            await session.deliver([
                message({ type: "commit", at: 1000, upTo: handoverAt, inputs: [] }),
                message({ type: "handover", at: handoverAt }),
                message({ type: "input", input: press.input, at: press.at, source: session.guest.id }),
            ]);
            session.lockstep().execute(handoverAt);
            session.lockstep().execute(15 * MsCycles);
            vi.advanceTimersByTime(15);
            keyboard.keyUp("a");
            session.lockstep().execute(5 * MsCycles);
            vi.advanceTimersByTime(5);
            keyboard.keyDown("a", false);
            session.lockstep().execute(100 * MsCycles);
            const keys = commitsSent(session.channel).flatMap(({ at, inputs }) => inputs.map(({ down }) => [down, at]));
            expect(keys[0]).toEqual([true, handoverAt]);
            const release = keys.find(([down]) => !down);
            const retap = keys.findLast(([down]) => down);
            expect(release[1] - handoverAt).toBeGreaterThanOrEqual(40 * MsCycles);
            expect(retap[1]).toBeGreaterThan(release[1]);
        });

        it("commits its own key pressed just before it is asked to stop, then stops after it", async () => {
            const { channel, deliver, lockstep, keyboard } = await inControl();
            lockstep().execute(500);
            keyboard().keyDown("a", false);
            await deliver([message({ type: "release" })]);
            const sent = channel.messages().filter((each) => each.type === "commit" || each.type === "released");
            expect(sent.at(-2)).toMatchObject({
                type: "commit",
                at: 1500,
                upTo: 1500,
                inputs: [{ kind: "key", down: true }],
            });
            expect(sent.at(-1)).toEqual({ type: "released", at: 1500, waiting: [] });
        });

        it("gives it up when the host sends a snapshot", async () => {
            const { channel, deliver, lockstep } = await inControl();
            await deliver(snapshotMessages(5000, [{ at: 5000, upTo: 6000, inputs: [] }]));
            lockstep().execute(500);
            expect(commitsSent(channel)).toEqual([]);
        });
    });

    describe("stamps each key", () => {
        const sentKeys = (channel) => channel.messages("input");
        const press = (keyboard) => keyboard().keyDown("a", false);
        const commit = (at, upTo) => message({ type: "commit", at, upTo, inputs: [] });

        it("with nothing before it has a machine to stamp against", async () => {
            const { channel, keyboard } = await joining();
            press(keyboard);
            const [key] = sentKeys(channel);
            expect(key.at).toBeUndefined();
            expect(key.snapshots).toBe(0);
        });

        it("and says in its summary how far ahead it stamps", async () => {
            const { channel, lockstep, keyboard } = await joinedAt(100000);
            press(keyboard);
            lockstep().execute(100);
            vi.advanceTimersByTime(StatsIntervalMs);
            lockstep().execute(100);
            expect(firstSummary(channel).stampAheadMs).toBeGreaterThanOrEqual(200 + 20);
        });

        it("afresh after a resync, counting the snapshots it has restored", async () => {
            const { channel, deliver, keyboard } = await joinedAt(100000);
            press(keyboard);
            await deliver(snapshotMessages(500, [{ at: 500, upTo: 600, inputs: [] }]));
            await deliver([commit(600, 700)]);
            press(keyboard);
            const [, second] = sentKeys(channel);
            expect(second).toMatchObject({ at: 700 + (200 + 20) * MsCycles, snapshots: 2 });
        });
    });

    it("ends a debugger run to a stop when it takes the host's machine", async () => {
        const { context } = await joinedAt(150);
        expect(context.loop.replacingState).toHaveBeenCalled();
    });

    it("tells the host once a second how it kept up", async () => {
        const { channel, lockstep } = await joinedAt(150);
        lockstep().execute(100);
        vi.advanceTimersByTime(1000);
        lockstep().execute(100);
        const stats = channel.messages("stats");
        expect(stats).toEqual([
            {
                type: "stats",
                stats: expect.objectContaining({ frames: 2, framesMaxGapMs: 1000, starved: 2, lagMs: 0 }),
            },
        ]);
    });

    it("counts the frames it runs while its page is hidden", async () => {
        const { channel, lockstep } = await joinedAt(150);
        page.hidden = () => true;
        lockstep().execute(100);
        vi.advanceTimersByTime(StatsIntervalMs);
        lockstep().execute(100);
        expect(firstSummary(channel).hiddenFrames).toBe(2);
    });

    it("opens the session pane once it has joined, and not again at a resync", async () => {
        const { context, deliver } = await joining();
        expect(panel().opens).toBe(0);
        await deliver(snapshotMessages(100, [{ at: 100, upTo: 100000, inputs: [] }]));
        expect(panel().opens).toBe(1);
        await deliver(snapshotMessages(200, [{ at: 200, upTo: 100000, inputs: [] }]));
        expect(context.processor.restoreState).toHaveBeenCalledTimes(2);
        expect(panel().opens).toBe(1);
    });

    it("measures its own round trip to the host, and shows and logs it", async () => {
        const { guest, context, channel, deliver, lockstep } = await joining();
        channel.emit("message", message(welcomeAs({ model: context.model.name, name: "Matt" })));
        await deliver(snapshotMessages(100, [{ at: 100, upTo: 100000, inputs: [] }]));
        lockstep().execute(100);
        vi.advanceTimersByTime(StatsIntervalMs);
        lockstep().execute(100);
        await settle();
        lockstep().execute(100);
        vi.advanceTimersByTime(StatsIntervalMs);
        lockstep().execute(100);
        expect(panel().peers[0]).toMatchObject({ label: "Matt", rttMs: 85 });
        expect(guest.report().events).toContainEqual(expect.objectContaining({ event: "connection", rttMs: 85 }));
    });

    it.each([
        ["far behind the host", CyclesPerSecond, 2],
        ["behind by no more than a slice over the limit", MaxGuestLagSeconds * CyclesPerSecond + 50, undefined],
    ])("counts a frame as catching up only when it starts far behind: %s", async (_, behind, catchingUp) => {
        const { channel, lockstep } = await joinedAt(100 + behind);
        lockstep().execute(100);
        vi.advanceTimersByTime(1000);
        lockstep().execute(100);
        const { catchingUp: counted, starved } = firstSummary(channel);
        expect([counted, starved]).toEqual([catchingUp, undefined]);
    });

    it("cancels its own paste or autoboot when it joins", async () => {
        const { context } = await joining();
        expect(context.keyboard.cancelPaste).toHaveBeenCalledTimes(1);
    });

    it("goes back to running on its own if it cannot join", async () => {
        const context = fakeContext({
            transport: fakeTransport({ join: vi.fn(async () => Promise.reject(new Error("No such room"))) }),
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
        await deliver(snapshotMessages(700, [], { chunks: 3 }));
        expect(context.processor.restoreState.mock.calls[0][0].cycles).toBe(700);
    });

    it("leaves the session on more snapshot than the host said it would send", async () => {
        const { context, channel, deliver } = await joining();
        const [header, ...chunks] = snapshotMessages(700);
        channel.emit("message", message({ ...JSON.parse(header.data), bytes: 10 }));
        await deliver(chunks);
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
    });

    it("restores each snapshot in turn and replays the commits that follow it", async () => {
        const { context, deliver, lockstep } = await joining();
        await deliver([
            ...snapshotMessages(100, [{ at: 100, upTo: 150, inputs: [] }]),
            ...snapshotMessages(500, [{ at: 500, upTo: 600, inputs: [] }]),
        ]);
        const { processor } = context;
        expect(processor.restoreState.mock.calls.map(([state]) => state.cycles)).toEqual([100, 500]);
        lockstep().execute(1000);
        expect(processor.currentCycles).toBe(600);
    });

    describe("desyncing", () => {
        const bogus = (at) => ({ at, upTo: at + 50, inputs: [], hash: "bogus" });
        const partsAt = (at) => snapshotMessages(at, [bogus(at), bogus(at + 50)]);

        async function desyncedAt(at) {
            const parts = await joining();
            await parts.deliver(partsAt(at));
            parts.lockstep().execute(100);
            return parts;
        }

        it("says so and why, plainly that a second is a bug, and nothing more after, asking one resync each time", async () => {
            const { channel, deliver, lockstep } = await desyncedAt(100);
            for (const at of [300, 500]) {
                await deliver(partsAt(at));
                lockstep().execute(100);
            }
            expect(channel.messages("resync")).toHaveLength(3);
            expect(desyncNotices()).toEqual([
                "This machine desynced: state differs at cycle 150. Resyncing; please save a session report.",
                "Another desync. This machine desynced: state differs at cycle 350. More than one in a " +
                    "session is a bug: please save a session report here and on the host, and send both with a bug " +
                    "report.",
            ]);
        });

        it("logs where, in which commit, and both hashes, and counts it in its summary", async () => {
            const { guest, context, channel, lockstep } = await desyncedAt(100);
            expect(events(guest, "desync")[0]).toEqual({
                ms: expect.any(Number),
                event: "desync",
                reason: "state differs at cycle 150",
                cycle: 150,
                at: 100,
                upTo: 150,
                expectedHash: "bogus",
                hash: stateHash(context.processor),
            });
            vi.advanceTimersByTime(StatsIntervalMs);
            lockstep().execute(100);
            expect(firstSummary(channel).desyncs).toBe(1);
        });
    });

    it("gives the guest the host's clock and offset, and its own back when the host goes", async () => {
        const { context, channel, deliver } = await joining();
        const { cmos } = context.processor.sysvia;
        const rtcBaseMs = Date.UTC(2026, 1, 10, 12, 0, 0);
        const rtcOffsetMs = MsPerMinute;
        await deliver(snapshotMessages(CyclesPerSecond * 3, [], { rtcBaseMs, rtcOffsetMs }));
        await settle();
        expect(cmos.bbcDateTime().getTime()).toBe(rtcBaseMs + 3000 + rtcOffsetMs);
        channel.emit("close");
        expect(cmos.bbcDateTime().getTime()).toBe(Math.floor(Date.now() / 1000) * 1000);
    });

    it.each([
        ["something it cannot read", "{not json"],
        ["a commit it cannot read", { type: "commit", at: "soon", upTo: 1, inputs: [] }],
        ["a snapshot of an impossible size", { type: "snapshot", bytes: -1 }],
        ["a welcome from another version", { type: "welcome", model: "BBC B with 8271 (DFS 1.2)", version: "0.9" }],
        ["a welcome with no machine in it", { type: "welcome", model: 42, version: "1.0" }],
        ["a welcome naming no machine there is", { type: "welcome", model: "Nonesuch", version: "1.0" }],
        [
            "a welcome with a setting no page would take",
            welcomeAs({ takenFromHost: { ...StockTakenFromHost, tubeCpuMultiplier: 0 } }),
        ],
        ["a message that is not an object", null],
    ])("leaves the session on %s, noting it as a protocol failure", async (_, body) => {
        const sent = sentEvents();
        const { context, channel } = await joining();
        channel.emit("message", typeof body === "string" ? { data: body } : message(body));
        expect(context.loop.setLockstep).toHaveBeenLastCalledWith(null);
        expect(page.reloads).toEqual([]);
        expect(sent("session").at(-1)).toEqual({ role: "guest", stage: "failed", reason: "protocol" });
    });

    it("reloads as the host's model, saying goodbye once", async () => {
        const { channel } = await joining();
        channel.emit("message", message(welcomeAs({ model: "BBC Master 128 (DFS)" })));
        page.hide();
        expect(page.reloads).toEqual([expect.objectContaining({ model: "BBC Master 128 (DFS)" })]);
        expect(channel.messages("bye")).toHaveLength(1);
    });

    const differentValue = (name) =>
        ({
            [ParamTypes.BOOL]: !StockTakenFromHost[name],
            [ParamTypes.INT]: 7,
            [ParamTypes.FLOAT]: 2.5,
        })[Parameters[name].type];
    const allDifferent = Object.fromEntries(TakenFromHostNames.map((name) => [name, differentValue(name)]));

    it.each([
        ["the host is the same machine", StockTakenFromHost, {}],
        ["it already runs with every one of the host's settings", allDifferent, { takenFromHost: allDifferent }],
        [
            "the host's welcome has no settings at all, as the defaults",
            StockTakenFromHost,
            { takenFromHost: undefined },
        ],
        [
            "the host's welcome has no tube speed, as the default",
            StockTakenFromHost,
            { takenFromHost: { ...StockTakenFromHost, tubeCpuMultiplier: undefined } },
        ],
    ])("stays as it is when %s", async (_, own, fields) => {
        const { context, channel } = await joining({ takenFromHost: own });
        channel.emit("message", message(welcomeAs(fields)));
        expect(page.reloads).toEqual([]);
        expect(context.loop.setLockstep).not.toHaveBeenLastCalledWith(null);
    });

    it.each([
        [
            "with every one of the host's settings that differs from its own",
            StockTakenFromHost,
            allDifferent,
            { model: "B-DFS1.2", ...allDifferent },
        ],
        [
            "dropping its own settings where the host has the defaults",
            allDifferent,
            StockTakenFromHost,
            StockTakenFromHost,
        ],
    ])("reloads %s", async (_, own, host, reloaded) => {
        const { channel } = await joining({ takenFromHost: own });
        channel.emit("message", message(welcomeAs({ takenFromHost: host })));
        expect(page.reloads).toEqual([expect.objectContaining(reloaded)]);
        expect(channel.messages().at(-1)).toEqual({ type: "bye" });
    });
});

describe("a host and its guests, joined in-process", () => {
    async function session(names) {
        const transport = inProcessTransport();
        const hostContext = fakeContext({ transport, page: fakePage() });
        const host = new SessionHost(hostContext, "room", "Matt");
        hosts.push(host);
        await host.start();
        const joined = [];
        for (const name of names) {
            const context = fakeContext({ transport, page: fakePage(), processor: fakeProcessor({ cycles: 0 }) });
            const guest = new SessionGuest(context, "room", name);
            guests.push(guest);
            await guest.start();
            await settle();
            joined.push({
                guest,
                context,
                run: (cycles) => context.loop.setLockstep.mock.calls.at(-1)[0].execute(cycles),
            });
        }
        return { host, hostContext, guests: joined };
    }

    const panelOf = (context) => context.page.panels.at(-1);

    it("welcomes each guest by name with the host's machine, and each sees the others", async () => {
        const { host, hostContext, guests } = await session(["Kieran", "Ana"]);
        for (const { context } of guests) expect(context.processor.currentCycles).toBe(1000);
        const joining = guests[0].guest.report().events.map(({ event }) => event);
        expect(joining.indexOf("connected")).toBeLessThan(joining.indexOf("welcome"));
        expect(panelOf(hostContext).peers.map(({ label }) => label)).toEqual(["Matt (you)", "Kieran", "Ana"]);
        expect(host.connectedCount()).toBe(2);
        host.showStatus();
        await settle();
        expect(panelOf(guests[1].context).peers.map(({ label }) => label)).toEqual(["Matt", "Kieran", "Ana (you)"]);
    });

    it("lets go of a guest's keys when its page goes, on every machine", async () => {
        const { host, hostContext, guests } = await session(["Kieran", "Ana"]);
        guests[0].context.keyboard.setInput.mock.calls.at(-1)[0].keyDown("a", false);
        await settle();
        host.execute(CyclesPerSecond);
        guests[0].context.page.hide();
        await settle();
        host.execute(0);
        await settle();
        guests[1].run(2 * CyclesPerSecond);
        for (const { processor } of [hostContext, guests[1].context]) {
            expect(processor.sysvia.setMapped.mock.calls).toEqual([
                [[4, 1], 1],
                [[4, 1], 0],
            ]);
        }
        expect(panelOf(hostContext).peers.at(-1)).toMatchObject({ label: "Kieran", state: "left" });
    });

    it("leaves each guest's machine running on its own when the host goes", async () => {
        const { host, guests } = await session(["Kieran"]);
        host.close();
        await settle();
        expect(guests[0].guest.left).toBe(true);
        expect(guests[0].context.loop.setLockstep).toHaveBeenLastCalledWith(null);
        expect(guests[0].context.page.notices).toContain("Lost the host; the machine carries on here on its own.");
    });
});

describe("startSessionFromUrl", () => {
    async function started(params, contextOptions) {
        const context = fakeContext(contextOptions);
        const session = startSessionFromUrl(params, context);
        if (session instanceof SessionGuest) guests.push(session);
        else if (session) hosts.push(session);
        await settle();
        return context.transport;
    }

    it("hosts with ?server=, which wins over ?client=", async () => {
        const { createRoom, join } = await started({ server: "here", client: "there" });
        expect(createRoom).toHaveBeenCalledWith("here");
        expect(join).not.toHaveBeenCalled();
    });

    it("joins with ?client=", async () => {
        const { join } = await started({ client: "there" });
        expect(join).toHaveBeenCalledWith("there", expect.any(String), expect.any(Object));
    });

    it("shows a guest's session in the lights as it joins, under a name of its own", async () => {
        await started({ client: "there" });
        expect(page.panels).toHaveLength(1);
        expect(panel().opens).toBe(0);
        expect(panel().peers[0].state).toBe("connecting");
        expect(guests[0].name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    });

    it("returns the session it started, and nothing when none was asked for", () => {
        hosts.push(startSessionFromUrl({ server: "here" }, fakeContext()));
        expect(hosts[0]).toBeInstanceOf(SessionHost);
        expect(startSessionFromUrl({}, fakeContext())).toBeNull();
    });

    it.each([
        [
            "a guest with no such room",
            "client",
            404,
            `there's no room called "there"; check its name, or the host's page may have closed`,
            "no_room",
        ],
        [
            "a guest with too many joining",
            "client",
            429,
            "too many people are joining at once; try again in a moment",
            "too_many_joining",
        ],
        [
            "a guest with an offer already waiting",
            "client",
            409,
            "this page is already waiting to join; reload it to try again",
            "already_waiting",
        ],
        ["a guest refused for anything else", "client", 500, "Rendezvous failed with status 500", "other"],
        [
            "a host with no rendezvous to host with",
            "server",
            404,
            "the shared session service isn't available here",
            "service_unavailable",
        ],
        ["a host whose room is already open", "server", 409, `a room called "there" is already open`, "room_taken"],
    ])(
        "says what went wrong in plain words for %s, and notes it without its words",
        async (_, role, status, why, reason) => {
            const sent = sentEvents();
            vi.spyOn(console, "error").mockImplementation(() => {});
            const refuse = vi.fn(async () => {
                throw new RendezvousError(`Rendezvous failed with status ${status}`, status);
            });
            await started({ [role]: "there" }, { transport: fakeTransport({ join: refuse, createRoom: refuse }) });
            expect(page.notices).toContain(`The session couldn't start: ${why}.`);
            expect(sent("session").at(-1)).toEqual({
                role: role === "server" ? "host" : "guest",
                stage: "failed",
                reason,
            });
        },
    );

    it.each([
        ["no session asked for", {}, {}, []],
        ["an Atom", { server: "here" }, { model: { isAtom: true } }, ["unsupported_machine"]],
        [
            "a second processor",
            { server: "here" },
            { processor: Object.assign(fakeProcessor(), { hasTube: true }) },
            ["unsupported_machine"],
        ],
    ])("starts nothing for %s", async (_, params, contextOptions, failures) => {
        const sent = sentEvents();
        const { createRoom, join } = await started(params, contextOptions);
        expect(createRoom).not.toHaveBeenCalled();
        expect(join).not.toHaveBeenCalled();
        expect(sent("session")).toEqual(failures.map((reason) => ({ role: "host", stage: "failed", reason })));
    });
});

describe("hostSession", () => {
    afterEach(() => window.history.replaceState(null, "", "/"));

    const taken = () => new RendezvousError("Rendezvous create room failed with status 409", 409);

    it("hosts a room with a name of its own, on the machine as it is, leaving the URL alone", async () => {
        window.history.replaceState(null, "", "/?model=Master#frag");
        const before = window.location.href;
        const context = fakeContext();
        const host = await hostSession(context, "matt");
        hosts.push(host);
        await settle();
        expect(context.transport.createRoom.mock.calls).toEqual([[host.room]]);
        expect(host.room).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
        expect(host.name).toBe("matt");
        expect(panel().opens).toBe(1);
        expect(window.location.href).toBe(before);
    });

    it("tries another name when the one it made up is taken", async () => {
        const createRoom = vi.fn(async () => "secret").mockRejectedValueOnce(taken());
        const host = await hostSession(fakeContext({ transport: fakeTransport({ createRoom }) }), "matt");
        hosts.push(host);
        await settle();
        expect(createRoom).toHaveBeenCalledTimes(2);
        expect(createRoom.mock.calls[1][0]).toBe(host.room);
        expect(createRoom.mock.calls[0][0]).not.toBe(host.room);
        expect(page.panels).toHaveLength(1);
    });

    it.each([
        ["every name it tries is taken", () => taken(), 3, "room_taken"],
        [
            "the rendezvous fails",
            () => new RendezvousError("Rendezvous create room failed with status 500", 500),
            1,
            "other",
        ],
        ["the network fails", () => new TypeError("Failed to fetch"), 1, "other"],
    ])("leaves the page with no session at all when %s, noting why", async (_, error, tries, reason) => {
        const sent = sentEvents();
        vi.spyOn(console, "error").mockImplementation(() => {});
        const createRoom = vi.fn(async () => {
            throw error();
        });
        const context = fakeContext({ transport: fakeTransport({ createRoom }) });
        expect(await hostSession(context, "matt")).toBeNull();
        await settle();
        expect(createRoom).toHaveBeenCalledTimes(tries);
        expect(page.panels).toEqual([]);
        expect(context.loop.setLockstep).not.toHaveBeenCalled();
        expect(page.notices).toHaveLength(1);
        expect(page.notices[0]).toMatch(/^The session couldn't start: /);
        expect(sent("session")).toEqual([{ role: "host", stage: "failed", reason }]);
    });

    it("refuses a machine that cannot take part, and starts nothing", async () => {
        const context = fakeContext({ model: { isAtom: true } });
        expect(await hostSession(context, "matt")).toBeNull();
        await settle();
        expect(context.transport.createRoom).not.toHaveBeenCalled();
    });
});

describe("joinLink", () => {
    afterEach(() => window.history.replaceState(null, "", "/"));

    it("keeps nothing of this page's own query or fragment, and adds the name if there is one", () => {
        window.history.replaceState(null, "", "/?model=Master&disc=elite.ssd#frag");
        expect(joinLink("brave-owls-sing")).toBe(`${window.location.origin}/?client=brave-owls-sing`);
        expect(joinLink("brave-owls-sing", "matt g")).toBe(
            `${window.location.origin}/?client=brave-owls-sing&name=matt%20g`,
        );
    });

    it("gives the name back as it was when the link is read", () => {
        const query = new URL(joinLink("brave-owls-sing", "matt g")).search.substring(1);
        expect(parseQueryString(query, urlParamType).name).toBe("matt g");
    });

    it("keeps the settings local to the page and the input mappings it is given, and nothing that changes the machine", () => {
        const params = {
            model: "Master",
            disc: "elite.ssd",
            rom: ["a.rom"],
            "rom.7": ["github:o/r/x.rom"],
            cpuMultiplier: 2,
            server: "old-room",
            client: "old-room",
            name: "old name",
            audioLatencyMs: 80,
            embed: true,
            "KEY.CAPSLOCK": "CTRL",
            "GP.FIRE2": "RETURN",
            "gp.fire1": "SPACE",
            FIRE: "SPACE",
            fire: "SPACE",
        };
        expect(joinLink("brave-owls-sing", "matt", params)).toBe(
            `${window.location.origin}/?client=brave-owls-sing&name=matt&audioLatencyMs=80&embed` +
                "&KEY.CAPSLOCK=CTRL&GP.FIRE2=RETURN&gp.fire1=SPACE&FIRE=SPACE",
        );
    });
});

describe("roomFrom", () => {
    it.each([
        ["a room's name", "brave-owls-sing", "brave-owls-sing"],
        ["a name with spaces round it", "  Room_1 \n", "Room_1"],
        ["a link to join", "https://bbc.xania.org/?client=brave-owls-sing", "brave-owls-sing"],
        ["a link without its scheme", "bbc.xania.org/?client=brave-owls-sing", "brave-owls-sing"],
        ["a name in capitals, as a URL can host", "Brave-Owls", "Brave-Owls"],
        ["a host's own link", "http://localhost:5173/?server=brave-owls-sing&model=Master", "brave-owls-sing"],
        ["nothing", "   ", null],
        ["words with spaces", "brave owls sing", null],
        ["a link with no room in it", "https://bbc.xania.org/?disc=elite.ssd", null],
        ["a link to a room no rendezvous would take", "https://bbc.xania.org/?client=a/b", null],
        ["a name too long for the rendezvous", "x".repeat(65), null],
    ])("reads %s", (_, text, room) => {
        expect(roomFrom(text)).toBe(room);
    });
});
