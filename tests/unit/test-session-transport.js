import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    AnswerTimeoutMs,
    ConnectTimeoutMs,
    IceGatheringTimeoutMs,
    MaxConnectingGuests,
    webRtcTransport,
} from "../../src/web/session-transport.js";
import { SessionFailures } from "../../src/web/shared-session.js";
import { OfferLifetimeSeconds } from "../../rendezvous/handler.js";

class FakeEvents {
    constructor() {
        this.listeners = {};
    }

    addEventListener(type, listener, { signal } = {}) {
        if (signal?.aborted) return;
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(listener);
        signal?.addEventListener("abort", () => this.listeners[type].splice(this.listeners[type].indexOf(listener), 1));
    }

    emit(type, event = {}) {
        for (const listener of [...(this.listeners[type] ?? [])]) listener(event);
    }
}

class FakeChannel extends FakeEvents {
    constructor(readyState = "open") {
        super();
        this.readyState = readyState;
    }

    open() {
        this.readyState = "open";
        this.emit("open");
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
                { id: "P", type: "candidate-pair", currentRoundTripTime: 0.085 },
            ].map((entry) => [entry.id, entry]),
        );
    }

    createDataChannel() {
        this.channel = new FakeChannel("connecting");
        return this.channel;
    }

    close() {
        this.closed = true;
    }
}

const Candidate = "a=candidate:1 1 udp 2113937151 peer.local 54336 typ host";

// A peer still looking for its ICE candidates, which finds one when told to.
class GatheringPeer extends FakePeer {
    constructor() {
        super();
        this.iceGatheringState = "gathering";
        this.localDescription = { sdp: "v=0" };
    }

    find({ announced = true } = {}) {
        this.localDescription = { sdp: `v=0\r\n${Candidate}` };
        if (announced) this.emit("icecandidate", { candidate: {} });
    }
}

function fakeRendezvous(overrides = {}) {
    return {
        createRoom: vi.fn(async () => "secret"),
        deleteRoom: vi.fn(async () => {}),
        listOffers: vi.fn(async () => []),
        postAnswer: vi.fn(async () => {}),
        postOffer: vi.fn(async () => {}),
        getAnswer: vi.fn(async () => "answer sdp"),
        ...overrides,
    };
}

// What a link told its end, in order.
function recorder() {
    const heard = [];
    return {
        heard,
        offered: () => heard.push(["offered"]),
        answered: () => heard.push(["answered"]),
        message: (data) => heard.push(["message", data]),
        closed: (reason) => heard.push(["closed", reason]),
    };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    peers = [];
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("webRtcTransport, as a host listens", () => {
    let listening;

    afterEach(() => listening?.close());

    function listen(rendezvous, host = {}) {
        const links = [];
        const listeners = [];
        listening = webRtcTransport(rendezvous).listen("room", "secret", {
            connecting: (id, link) => {
                links.push(link);
                listeners.push(recorder());
                return listeners.at(-1);
            },
            reopened: vi.fn(),
            gone: vi.fn(),
            ...host,
        });
        return { links, listeners };
    }

    const offering = (...guests) => {
        const offers = guests.map((guest) => ({ guest, sdp: "offer" }));
        return fakeRendezvous({ listOffers: vi.fn(async () => offers.splice(0)) });
    };

    it("opens a link only with its channel, refusing sends until then, and says why it closed", async () => {
        const { links, listeners } = listen(offering("g1"));
        await settle();
        expect(() => links[0].send("hello")).toThrow("the channel is not open");
        const channel = new FakeChannel("connecting");
        peers[0].emit("datachannel", { channel });
        expect(links[0].isOpen()).toBe(false);
        channel.open();
        await settle();
        expect(links[0].isOpen()).toBe(true);
        expect(listeners[0].heard).toEqual([]);
        expect(await links[0].stats()).toMatchObject({ rttMs: 85 });
        channel.emit("close");
        expect(listeners[0].heard.at(-1)).toEqual(["closed", "its channel closed"]);
    });

    it("ignores a guest's second channel, which would cost another snapshot", async () => {
        const { listeners } = listen(offering("g1"));
        await settle();
        const second = new FakeChannel();
        peers[0].emit("datachannel", { channel: new FakeChannel() });
        peers[0].emit("datachannel", { channel: second });
        await settle();
        second.emit("message", { data: "hi" });
        expect(listeners[0].heard).toEqual([]);
    });

    it("tells the host nothing more of a link the host has closed", async () => {
        const { links, listeners } = listen(offering("g1"));
        await settle();
        const channel = new FakeChannel();
        peers[0].emit("datachannel", { channel });
        await settle();
        links[0].close();
        channel.emit("message", { data: "late" });
        channel.emit("close");
        expect(peers[0].closed).toBe(true);
        expect(listeners[0].heard).toEqual([]);
    });

    it.each([
        ["opens no channel", () => {}, "it never opened a channel"],
        [
            "opens a channel that never opens",
            () => peers[0].emit("datachannel", { channel: new FakeChannel("connecting") }),
            "its channel never opened",
        ],
    ])("gives up on a guest that %s", async (_, connect, reason) => {
        const { listeners } = listen(offering("g1"));
        await settle();
        connect();
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(listeners[0].heard).toEqual([["closed", reason]]);
    });

    it("opens its room again if it finds it gone, and says so if it cannot", async () => {
        const gone = Object.assign(new Error("Rendezvous list offers failed with status 404"), { status: 404 });
        const rendezvous = fakeRendezvous({ listOffers: vi.fn(async () => Promise.reject(gone)) });
        const reopened = vi.fn();
        const lost = vi.fn();
        listen(rendezvous, { reopened, gone: lost });
        await settle();
        expect(rendezvous.createRoom).toHaveBeenCalledTimes(1);
        expect(reopened).toHaveBeenCalledOnce();
        rendezvous.createRoom.mockRejectedValue(new Error("Room already exists"));
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(lost).toHaveBeenCalledWith(new Error("Room already exists"));
        const polls = rendezvous.listOffers.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(rendezvous.listOffers.mock.calls.length).toBe(polls);
    });

    it("stops listening and deletes the room when closed", async () => {
        const rendezvous = fakeRendezvous();
        listen(rendezvous);
        await settle();
        listening.close();
        const polls = rendezvous.listOffers.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(rendezvous.listOffers.mock.calls.length).toBe(polls);
        expect(rendezvous.deleteRoom).toHaveBeenCalledWith("room", "secret");
    });

    it("opens only a few connections at a time, and frees the place of one that never completes", async () => {
        const offers = Array.from({ length: MaxConnectingGuests + 2 }, (_, i) => ({ guest: `g${i}`, sdp: "offer" }));
        listen(fakeRendezvous({ listOffers: vi.fn(async () => offers) }));
        await settle();
        expect(peers).toHaveLength(MaxConnectingGuests);
        await vi.advanceTimersByTimeAsync(2 * ConnectTimeoutMs);
        expect(peers).toHaveLength(MaxConnectingGuests + 2);
    });

    it("answers each offer once, even if answering it failed", async () => {
        const offer = { guest: "g1", sdp: "offer" };
        const postAnswer = vi.fn(async () =>
            Promise.reject(new Error("Rendezvous post answer failed with status 500")),
        );
        const { listeners } = listen(fakeRendezvous({ listOffers: vi.fn(async () => [offer]), postAnswer }));
        await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
        expect(postAnswer).toHaveBeenCalledTimes(1);
        expect(peers).toHaveLength(1);
        expect(listeners[0].heard).toEqual([
            ["closed", "answering it failed: Rendezvous post answer failed with status 500"],
        ]);
    });

    it.each([
        [
            "answers with the candidates it found, however long the first took",
            () => {},
            [["room", "secret", "g1", expect.stringContaining(Candidate)]],
        ],
        ["sends no answer to a guest it gave up on while still gathering", (link) => link.close(), []],
        [
            "sends no answer to a guest that outlasted its connect timeout while still gathering",
            () => vi.advanceTimersByTimeAsync(ConnectTimeoutMs - 2 * IceGatheringTimeoutMs - 1),
            [],
        ],
    ])("%s", async (_, meanwhile, answers) => {
        vi.stubGlobal("RTCPeerConnection", GatheringPeer);
        const rendezvous = offering("g1");
        const { links } = listen(rendezvous);
        await vi.advanceTimersByTimeAsync(2 * IceGatheringTimeoutMs);
        expect(rendezvous.postAnswer).not.toHaveBeenCalled();
        await meanwhile(links[0]);
        peers[0].find();
        await vi.advanceTimersByTimeAsync(IceGatheringTimeoutMs);
        expect(rendezvous.postAnswer.mock.calls).toEqual(answers);
    });
});

describe("webRtcTransport, as a guest joins", () => {
    it("waits for an offer's answer for less time than the rendezvous keeps the offer", () => {
        expect(AnswerTimeoutMs).toBeLessThan(OfferLifetimeSeconds * 1000);
    });

    it("tells of offer and answer, hands over the link once open, then what comes and why it closed", async () => {
        const rendezvous = fakeRendezvous({ getAnswer: vi.fn(async () => "answer sdp").mockResolvedValueOnce(null) });
        const listener = recorder();
        let link = null;
        webRtcTransport(rendezvous)
            .join("room", "g1", listener)
            .then((joined) => (link = joined));
        await vi.advanceTimersByTimeAsync(AnswerTimeoutMs / 2);
        expect(listener.heard).toEqual([["offered"], ["answered"]]);
        expect(link).toBeNull();
        peers[0].channel.open();
        await settle();
        expect(link.isOpen()).toBe(true);
        peers[0].channel.emit("message", { data: "welcome" });
        peers[0].channel.emit("close");
        expect(listener.heard.slice(2)).toEqual([
            ["message", "welcome"],
            ["closed", "lost the host"],
        ]);
    });

    it.each([
        ["the host never answers", { getAnswer: async () => null }, AnswerTimeoutMs + 1000, "the host isn't answering"],
        ["the host answers but the channel never opens", {}, ConnectTimeoutMs, "couldn't connect directly"],
    ])("gives up, as a timeout, and closes its connection, when %s", async (_, overrides, waitMs, message) => {
        const joined = webRtcTransport(fakeRendezvous(overrides)).join("room", "g1", recorder());
        const failed = expect(joined).rejects.toMatchObject({ message, sessionFailure: SessionFailures.timeout });
        await vi.advanceTimersByTimeAsync(waitMs);
        await failed;
        expect(peers[0].closed).toBe(true);
    });

    describe("its offer", () => {
        function joinWhileGathering(foundBeforeLooking) {
            vi.stubGlobal(
                "RTCPeerConnection",
                class extends GatheringPeer {
                    async setLocalDescription() {
                        if (foundBeforeLooking) this.find({ announced: false });
                    }
                },
            );
            const posted = [];
            const rendezvous = fakeRendezvous({ postOffer: async (...args) => posted.push([Date.now(), ...args]) });
            const started = webRtcTransport(rendezvous).join("room", "g1", recorder());
            return { started, posted };
        }

        it.each([
            ["waits for a first candidate however long it takes, then as long again for more", false, "gathering", 3],
            ["counts from a candidate already found when it starts waiting", true, "gathering", 1],
            ["goes as soon as gathering is complete", false, "complete", 2],
        ])("%s", async (_, foundBeforeLooking, gatheringState, postedAtGatheringTimeouts) => {
            const start = Date.now();
            const { posted } = joinWhileGathering(foundBeforeLooking);
            await vi.advanceTimersByTimeAsync(2 * IceGatheringTimeoutMs);
            peers[0].find({ announced: !foundBeforeLooking });
            peers[0].iceGatheringState = gatheringState;
            peers[0].emit("icegatheringstatechange");
            await vi.advanceTimersByTimeAsync(2 * IceGatheringTimeoutMs);
            const at = start + postedAtGatheringTimeouts * IceGatheringTimeoutMs;
            expect(posted).toEqual([[at, "room", "g1", expect.stringContaining(Candidate)]]);
        });

        it("gives up when no candidate comes, since nothing could connect", async () => {
            const { started, posted } = joinWhileGathering(false);
            const failed = expect(started).rejects.toThrow("found no address to connect from");
            await vi.advanceTimersByTimeAsync(ConnectTimeoutMs);
            await failed;
            expect(posted).toEqual([]);
            expect(peers[0].closed).toBe(true);
        });
    });
});
