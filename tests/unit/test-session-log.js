// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { connectionStats, IntervalStats, numbersOnly, SessionLog, StatsIntervalMs } from "../../src/web/session-log.js";

function clock() {
    let ms = 1000;
    return { now: () => ms, advance: (by) => (ms += by) };
}

describe("SessionLog", () => {
    it("times each event from the start of the session", () => {
        const { now, advance } = clock();
        const log = new SessionLog({ role: "host" }, now);
        advance(12.34);
        log.record("joined", { guest: "g1" });
        expect(log.report({ guests: [] })).toMatchObject({
            role: "host",
            guests: [],
            droppedEvents: 0,
            events: [{ ms: 12.3, event: "joined", guest: "g1" }],
        });
    });

    it("keeps the most recent events and counts the ones it let go", () => {
        const log = new SessionLog({});
        for (let i = 0; i < 20005; ++i) log.record("tick", { i });
        const { events, droppedEvents } = log.report();
        expect(droppedEvents).toBe(5);
        expect(events[0].i).toBe(5);
        expect(events.at(-1).i).toBe(20004);
    });
});

describe("IntervalStats", () => {
    it("hands over one summary per interval, with counts, peaks and the longest gap between ticks", () => {
        const { now, advance } = clock();
        const stats = new IntervalStats(now);
        stats.tick("frames");
        advance(16);
        stats.tick("frames");
        advance(50);
        stats.tick("frames");
        stats.count("starved");
        stats.peak("maxLagMs", 30);
        stats.peak("maxLagMs", 20);
        expect(stats.take()).toBeNull();
        advance(StatsIntervalMs);
        expect(stats.take()).toEqual({ frames: 3, framesMaxGapMs: 50, starved: 1, maxLagMs: 30 });
        expect(stats.take()).toBeNull();
    });
});

describe("numbersOnly", () => {
    it("keeps only the finite numbers of a peer's summary", () => {
        expect(numbersOnly({ lagMs: 4, note: "x", bad: Infinity, nested: {} })).toEqual({ lagMs: 4 });
        expect(numbersOnly("nonsense")).toEqual({});
        expect(numbersOnly(null)).toEqual({});
    });
});

describe("connectionStats", () => {
    const peer = (entries) => ({ getStats: async () => new Map(entries.map((entry) => [entry.id, entry])) });
    const candidates = [
        { id: "L", type: "local-candidate", candidateType: "srflx", protocol: "udp" },
        { id: "R", type: "remote-candidate", candidateType: "host" },
        { id: "D", type: "data-channel", messagesSent: 10, messagesReceived: 20 },
    ];

    it("reads the round trip and route of the pair the transport selected", async () => {
        const stats = await connectionStats(
            peer([
                { id: "T", type: "transport", selectedCandidatePairId: "P" },
                {
                    id: "P",
                    type: "candidate-pair",
                    localCandidateId: "L",
                    remoteCandidateId: "R",
                    currentRoundTripTime: 0.0854,
                },
                ...candidates,
            ]),
        );
        expect(stats).toEqual({
            rttMs: 85.4,
            route: "srflx/host",
            protocol: "udp",
            messagesSent: 10,
            messagesReceived: 20,
        });
    });

    it("finds the pair Firefox marks as selected", async () => {
        const stats = await connectionStats(
            peer([
                { id: "Q", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" },
                {
                    id: "P",
                    type: "candidate-pair",
                    selected: true,
                    localCandidateId: "L",
                    remoteCandidateId: "R",
                    currentRoundTripTime: 0.1,
                },
                ...candidates,
            ]),
        );
        expect(stats.rttMs).toBe(100);
    });

    it("says nothing of a connection it cannot find", async () => {
        expect(await connectionStats(peer([]))).toEqual({});
    });
});
