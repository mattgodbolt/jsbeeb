import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createHandler,
    MaxBodyBytes,
    MaxPendingOffers,
    OfferLifetimeSeconds,
    RoomLifetimeSeconds,
} from "../../rendezvous/handler.js";
import { createMemoryStore } from "../../rendezvous/memory-store.js";

const StartMs = 1800000000000;

function makeEvent(method, path, { body, headers = {}, isBase64Encoded = false } = {}) {
    return {
        rawPath: `/api/rendezvous${path}`,
        rawQueryString: "",
        headers,
        requestContext: { http: { method } },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        isBase64Encoded,
    };
}

describe("rendezvous handler", () => {
    let clockMs;
    let store;
    let handler;

    const advanceSeconds = (seconds) => (clockMs += seconds * 1000);

    async function call(method, path, options) {
        const response = await handler(makeEvent(method, path, options));
        return { ...response, json: JSON.parse(response.body) };
    }

    const host = (secret) => ({ "x-host-secret": secret });

    async function createRoom(room = "abc") {
        const { statusCode, json } = await call("POST", `/room/${room}`);
        expect(statusCode).toBe(201);
        return json.secret;
    }

    const postOffer = (guest, sdp = `offer from ${guest}`, room = "abc") =>
        call("POST", `/room/${room}/offer`, { body: { guest, sdp } });

    beforeEach(() => {
        clockMs = StartMs;
        store = createMemoryStore();
        handler = createHandler({ store, now: () => clockMs });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("the host and guest flow", () => {
        it("swaps an offer for an answer", async () => {
            const secret = await createRoom();
            expect((await postOffer("guest1", "v=0 offer")).statusCode).toBe(201);
            expect(await call("GET", "/room/abc/answer/guest1")).toMatchObject({ statusCode: 202, json: {} });

            const listed = await call("GET", "/room/abc/offers", { headers: host(secret) });
            expect(listed).toMatchObject({
                statusCode: 200,
                json: { offers: [{ guest: "guest1", sdp: "v=0 offer" }] },
            });

            const answered = await call("POST", "/room/abc/answer", {
                headers: host(secret),
                body: { guest: "guest1", sdp: "v=0 answer" },
            });
            expect(answered.statusCode).toBe(201);
            expect(await call("GET", "/room/abc/answer/guest1")).toMatchObject({
                statusCode: 200,
                json: { sdp: "v=0 answer" },
            });
            expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).json.offers).toEqual([]);
        });

        it("lets a guest read its answer again until the offer expires", async () => {
            const secret = await createRoom();
            await postOffer("guest1");
            await call("POST", "/room/abc/answer", { headers: host(secret), body: { guest: "guest1", sdp: "ans" } });
            expect((await call("GET", "/room/abc/answer/guest1")).json).toEqual({ sdp: "ans" });
            advanceSeconds(OfferLifetimeSeconds - 1);
            expect((await call("GET", "/room/abc/answer/guest1")).json).toEqual({ sdp: "ans" });
            advanceSeconds(1);
            expect((await call("GET", "/room/abc/answer/guest1")).statusCode).toBe(404);
        });

        it("keeps guests apart", async () => {
            const secret = await createRoom();
            await postOffer("guest1");
            await postOffer("guest2");
            await call("POST", "/room/abc/answer", { headers: host(secret), body: { guest: "guest1", sdp: "ans1" } });
            expect((await call("GET", "/room/abc/answer/guest2")).statusCode).toBe(202);
            expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).json.offers).toEqual([
                { guest: "guest2", sdp: "offer from guest2" },
            ]);
        });

        it("serves JSON that is never cached", async () => {
            const { headers } = await call("POST", "/room/abc");
            expect(headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
        });
    });

    describe("rooms", () => {
        it("returns a fresh base64url secret of 32 bytes and stores only its hash", async () => {
            const secret = await createRoom();
            expect(Buffer.from(secret, "base64url")).toHaveLength(32);
            expect(JSON.stringify(await store.query("abc"))).not.toContain(secret);
        });

        it("uses the injected random source", async () => {
            handler = createHandler({ store, now: () => clockMs, randomBytes: (size) => Buffer.alloc(size, 7) });
            expect(await createRoom()).toBe(Buffer.alloc(32, 7).toString("base64url"));
        });

        it("refuses to create a live room twice", async () => {
            await createRoom();
            const { statusCode, json } = await call("POST", "/room/abc");
            expect(statusCode).toBe(409);
            expect(json.error).toBe("Room already exists");
        });

        it("expires a room nobody polls, after which it can be created again", async () => {
            const oldSecret = await createRoom();
            advanceSeconds(RoomLifetimeSeconds);
            expect((await postOffer("guest1")).statusCode).toBe(404);
            expect((await call("GET", "/room/abc/offers", { headers: host(oldSecret) })).statusCode).toBe(404);
            const newSecret = await createRoom();
            expect(newSecret).not.toBe(oldSecret);
        });

        it("stays alive while the host polls", async () => {
            const secret = await createRoom();
            for (let i = 0; i < 3; ++i) {
                advanceSeconds(RoomLifetimeSeconds - 1);
                expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).statusCode).toBe(200);
            }
            advanceSeconds(RoomLifetimeSeconds - 1);
            expect((await postOffer("late")).statusCode).toBe(201);
        });

        it("deletes the room and everything in it", async () => {
            const secret = await createRoom();
            await postOffer("guest1");
            await call("POST", "/room/abc/answer", { headers: host(secret), body: { guest: "guest1", sdp: "ans" } });
            expect((await call("DELETE", "/room/abc", { headers: host(secret) })).statusCode).toBe(200);
            expect(await store.query("abc")).toEqual([]);
            expect((await call("GET", "/room/abc/answer/guest1")).statusCode).toBe(404);
            expect((await postOffer("guest2")).statusCode).toBe(404);
        });

        it("keeps rooms apart", async () => {
            await createRoom("one");
            const secretTwo = await createRoom("two");
            await postOffer("guest1", "sdp", "one");
            expect((await call("GET", "/room/two/offers", { headers: host(secretTwo) })).json.offers).toEqual([]);
            expect((await call("GET", "/room/one/offers", { headers: host(secretTwo) })).statusCode).toBe(403);
        });
    });

    describe("the host secret", () => {
        let secret;
        beforeEach(async () => {
            secret = await createRoom();
            await postOffer("guest1");
        });

        it.each([
            ["missing", {}],
            ["wrong", host("not-the-secret")],
        ])("is required to list offers (%s)", async (_, headers) => {
            expect((await call("GET", "/room/abc/offers", { headers })).statusCode).toBe(403);
        });

        it("is required to answer", async () => {
            const response = await call("POST", "/room/abc/answer", {
                headers: host("wrong"),
                body: { guest: "guest1", sdp: "ans" },
            });
            expect(response.statusCode).toBe(403);
            expect((await call("GET", "/room/abc/answer/guest1")).statusCode).toBe(202);
        });

        it("is required to delete", async () => {
            expect((await call("DELETE", "/room/abc", { headers: host("wrong") })).statusCode).toBe(403);
            expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).statusCode).toBe(200);
        });

        it("does not extend a room on a failed poll", async () => {
            advanceSeconds(RoomLifetimeSeconds - 1);
            await call("GET", "/room/abc/offers", { headers: host("wrong") });
            advanceSeconds(1);
            expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).statusCode).toBe(404);
        });
    });

    describe("offers", () => {
        let secret;
        beforeEach(async () => {
            secret = await createRoom();
        });

        it("refuses a second live offer from the same guest", async () => {
            await postOffer("guest1");
            expect((await postOffer("guest1")).statusCode).toBe(409);
        });

        it("expires an offer on its own clock, after which the guest may offer again", async () => {
            await postOffer("guest1");
            advanceSeconds(OfferLifetimeSeconds);
            expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).json.offers).toEqual([]);
            expect((await call("GET", "/room/abc/answer/guest1")).statusCode).toBe(404);
            expect((await postOffer("guest1", "second")).statusCode).toBe(201);
            expect((await call("GET", "/room/abc/answer/guest1")).statusCode).toBe(202);
        });

        it("does not let an expired answer stand for a new offer", async () => {
            await postOffer("guest1");
            await call("POST", "/room/abc/answer", { headers: host(secret), body: { guest: "guest1", sdp: "old" } });
            advanceSeconds(OfferLifetimeSeconds);
            await postOffer("guest1", "again");
            expect((await call("GET", "/room/abc/answer/guest1")).statusCode).toBe(202);
            expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).json.offers).toEqual([
                { guest: "guest1", sdp: "again" },
            ]);
        });

        it(`caps a room at ${MaxPendingOffers} pending offers`, async () => {
            for (let i = 0; i < MaxPendingOffers; ++i) expect((await postOffer(`guest${i}`)).statusCode).toBe(201);
            expect((await postOffer("onetoomany")).statusCode).toBe(429);
        });

        it("frees a place under the cap when an offer is answered", async () => {
            for (let i = 0; i < MaxPendingOffers; ++i) await postOffer(`guest${i}`);
            await call("POST", "/room/abc/answer", { headers: host(secret), body: { guest: "guest0", sdp: "ans" } });
            expect((await postOffer("next")).statusCode).toBe(201);
        });

        it("frees a place under the cap when an offer expires", async () => {
            for (let i = 0; i < MaxPendingOffers; ++i) await postOffer(`guest${i}`);
            advanceSeconds(OfferLifetimeSeconds);
            expect((await postOffer("next")).statusCode).toBe(201);
        });

        it("refuses an answer to a guest with no live offer", async () => {
            const response = await call("POST", "/room/abc/answer", {
                headers: host(secret),
                body: { guest: "nobody", sdp: "ans" },
            });
            expect(response.statusCode).toBe(404);
        });

        it("refuses an offer to a room that never existed", async () => {
            expect((await postOffer("guest1", "sdp", "nowhere")).statusCode).toBe(404);
            expect((await call("GET", "/room/nowhere/answer/guest1")).statusCode).toBe(404);
        });

        it("accepts a base64-encoded body", async () => {
            const body = Buffer.from(JSON.stringify({ guest: "guest1", sdp: "encoded" })).toString("base64");
            expect((await call("POST", "/room/abc/offer", { body, isBase64Encoded: true })).statusCode).toBe(201);
            expect((await call("GET", "/room/abc/offers", { headers: host(secret) })).json.offers).toEqual([
                { guest: "guest1", sdp: "encoded" },
            ]);
        });
    });

    describe("malformed requests", () => {
        beforeEach(async () => {
            await createRoom();
        });

        it.each([
            ["not JSON", "{"],
            ["no body", undefined],
            ["null", "null"],
            ["a bad guest ID", { guest: "has space", sdp: "x" }],
            ["an overlong guest ID", { guest: "g".repeat(65), sdp: "x" }],
            ["a missing sdp", { guest: "guest1" }],
            ["an empty sdp", { guest: "guest1", sdp: "" }],
            ["a non-string sdp", { guest: "guest1", sdp: 42 }],
        ])("refuses an offer with %s", async (_, body) => {
            expect((await call("POST", "/room/abc/offer", { body })).statusCode).toBe(400);
        });

        it("refuses a body over the size cap", async () => {
            const body = { guest: "guest1", sdp: "x".repeat(MaxBodyBytes) };
            expect((await call("POST", "/room/abc/offer", { body })).statusCode).toBe(413);
        });

        it.each(["has.dot", "r".repeat(65), "%20"])("refuses the room ID %s", async (room) => {
            expect((await call("POST", `/room/${room}`)).statusCode).toBe(400);
        });

        it("refuses a bad guest ID when reading an answer", async () => {
            expect((await call("GET", "/room/abc/answer/bad.id")).statusCode).toBe(400);
        });

        it.each([["/"], ["/room"], ["/room/abc/unknown"], ["/room/abc/answer/g/extra"]])(
            "has nothing at %s",
            async (path) => {
                expect((await call("GET", path)).statusCode).toBe(404);
            },
        );

        it("has nothing outside its prefix", async () => {
            const response = await handler({ ...makeEvent("GET", "/room/abc"), rawPath: "/elsewhere/room/abc" });
            expect(response.statusCode).toBe(404);
        });

        it("names the allowed methods on a wrong one", async () => {
            const response = await call("PUT", "/room/abc");
            expect(response.statusCode).toBe(405);
            expect(response.headers.allow).toBe("POST, DELETE");
        });
    });

    it("answers 500 without detail when the store fails", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const failingStore = {
            ...store,
            get: async () => {
                throw new Error("store down");
            },
        };
        handler = createHandler({ store: failingStore, now: () => clockMs });
        const response = await call("GET", "/room/abc/answer/guest1");
        expect(response).toMatchObject({ statusCode: 500, json: { error: "Internal error" } });
        expect(logged).toHaveBeenCalledOnce();
    });
});

describe("memory store", () => {
    it("writes conditionally only over an absent or expired item", async () => {
        const store = createMemoryStore();
        expect(await store.put({ room: "r", entry: "e", expires: 100, v: 1 }, { unlessLiveAt: 50 })).toBe(true);
        expect(await store.put({ room: "r", entry: "e", expires: 200, v: 2 }, { unlessLiveAt: 99 })).toBe(false);
        expect(await store.put({ room: "r", entry: "e", expires: 200, v: 3 }, { unlessLiveAt: 100 })).toBe(true);
        expect(await store.get("r", "e")).toEqual({ room: "r", entry: "e", expires: 200, v: 3 });
    });

    it("keeps expired items until they are deleted", async () => {
        const store = createMemoryStore();
        await store.put({ room: "r", entry: "e", expires: 1 });
        expect(await store.query("r")).toEqual([{ room: "r", entry: "e", expires: 1 }]);
        await store.delete("r", "e");
        expect(await store.get("r", "e")).toBeUndefined();
        expect(await store.query("r")).toEqual([]);
    });

    it("hands out copies", async () => {
        const store = createMemoryStore();
        await store.put({ room: "r", entry: "e", expires: 1 });
        (await store.get("r", "e")).expires = 99;
        expect((await store.get("r", "e")).expires).toBe(1);
    });
});
