import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createHandler,
    MaxBodyBytes,
    MaxPendingOffers,
    OfferLifetimeSeconds,
    PathPrefix,
    RoomLifetimeSeconds,
    SecretBytes,
} from "../../rendezvous/handler.js";
import { createMemoryStore } from "../../rendezvous/memory-store.js";
import { toFunctionUrlEvent } from "../../rendezvous/vite-plugin.js";
import { createRendezvousClient, RendezvousError } from "../../src/web/rendezvous-client.js";

const StartMs = 1800000000000;
const Room = "abc";

const asBody = (body) => Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));

const devServerEvent = (method, url, { body, headers = {} } = {}) =>
    toFunctionUrlEvent({ method, url, headers }, asBody(body));

function devServerFetch(handler) {
    return async (url, { method, headers, body }) => {
        const response = await handler()(devServerEvent(method, url, { body, headers }));
        return new Response(response.body, { status: response.statusCode, headers: response.headers });
    };
}

const refuses = (promise, status) => expect(promise).rejects.toMatchObject({ status });

describe("rendezvous", () => {
    let clockMs;
    let store;
    let handler;
    let rendezvous;

    const advanceSeconds = (seconds) => (clockMs += seconds * 1000);
    const offer = (guest, sdp = `offer from ${guest}`, room = Room) => rendezvous.postOffer(room, guest, sdp);

    /** Time passing with the host polling each second, as a live one does, so its room outlives the offers in it. */
    async function advanceWhileHostPolls(seconds, secret) {
        for (let i = 0; i < seconds; ++i) {
            advanceSeconds(1);
            await rendezvous.listOffers(Room, secret);
        }
    }

    /** A request the client would never make. */
    async function request(method, path, options) {
        const response = await handler(devServerEvent(method, `${PathPrefix}${path}`, options));
        return { ...response, json: JSON.parse(response.body) };
    }

    beforeEach(() => {
        clockMs = StartMs;
        store = createMemoryStore();
        handler = createHandler({ store, now: () => clockMs });
        rendezvous = createRendezvousClient({ fetch: devServerFetch(() => handler) });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("the host and guest flow", () => {
        it("swaps an offer for an answer", async () => {
            const secret = await rendezvous.createRoom(Room);
            await offer("guest1", "v=0 offer");
            expect(await rendezvous.getAnswer(Room, "guest1")).toBeNull();
            expect(await rendezvous.listOffers(Room, secret)).toEqual([{ guest: "guest1", sdp: "v=0 offer" }]);
            await rendezvous.postAnswer(Room, secret, "guest1", "v=0 answer");
            expect(await rendezvous.getAnswer(Room, "guest1")).toBe("v=0 answer");
            expect(await rendezvous.listOffers(Room, secret)).toEqual([]);
        });

        it("lets a guest read its answer again until the offer expires", async () => {
            const secret = await rendezvous.createRoom(Room);
            await offer("guest1");
            await rendezvous.postAnswer(Room, secret, "guest1", "ans");
            expect(await rendezvous.getAnswer(Room, "guest1")).toBe("ans");
            await advanceWhileHostPolls(OfferLifetimeSeconds - 1, secret);
            expect(await rendezvous.getAnswer(Room, "guest1")).toBe("ans");
            await advanceWhileHostPolls(1, secret);
            await refuses(rendezvous.getAnswer(Room, "guest1"), 404);
        });

        it("keeps guests apart", async () => {
            const secret = await rendezvous.createRoom(Room);
            await offer("guest1");
            await offer("guest2");
            await rendezvous.postAnswer(Room, secret, "guest1", "ans1");
            expect(await rendezvous.getAnswer(Room, "guest2")).toBeNull();
            expect(await rendezvous.listOffers(Room, secret)).toEqual([{ guest: "guest2", sdp: "offer from guest2" }]);
        });

        it("serves JSON that is never cached", async () => {
            const { headers } = await request("POST", `/room/${Room}`);
            expect(headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
        });
    });

    describe("rooms", () => {
        it("returns a fresh base64url secret of 32 bytes and stores only its hash", async () => {
            const secret = await rendezvous.createRoom(Room);
            expect(Buffer.from(secret, "base64url")).toHaveLength(SecretBytes);
            expect(JSON.stringify(await store.query(Room))).not.toContain(secret);
        });

        it("uses the injected random source", async () => {
            handler = createHandler({ store, now: () => clockMs, randomBytes: (size) => Buffer.alloc(size, 7) });
            expect(await rendezvous.createRoom(Room)).toBe(Buffer.alloc(SecretBytes, 7).toString("base64url"));
        });

        it("refuses to create a live room twice, and says why", async () => {
            await rendezvous.createRoom(Room);
            const error = await rendezvous.createRoom(Room).catch((e) => e);
            expect(error).toBeInstanceOf(RendezvousError);
            expect(error).toMatchObject({
                status: 409,
                message: "Rendezvous create room failed with status 409: Room already exists",
            });
        });

        it("expires a room nobody polls, after which it can be created again", async () => {
            const oldSecret = await rendezvous.createRoom(Room);
            advanceSeconds(RoomLifetimeSeconds);
            await refuses(offer("guest1"), 404);
            await refuses(rendezvous.listOffers(Room, oldSecret), 404);
            expect(await rendezvous.createRoom(Room)).not.toBe(oldSecret);
        });

        it("stays alive while the host polls", async () => {
            const secret = await rendezvous.createRoom(Room);
            for (let i = 0; i < 3; ++i) {
                advanceSeconds(RoomLifetimeSeconds - 1);
                await rendezvous.listOffers(Room, secret);
            }
            advanceSeconds(RoomLifetimeSeconds - 1);
            await offer("late");
        });

        it("deletes the room and everything in it", async () => {
            const secret = await rendezvous.createRoom(Room);
            await offer("guest1");
            await rendezvous.postAnswer(Room, secret, "guest1", "ans");
            await rendezvous.deleteRoom(Room, secret);
            expect(await store.query(Room)).toEqual([]);
            await refuses(rendezvous.getAnswer(Room, "guest1"), 404);
            await refuses(offer("guest2"), 404);
        });

        it("does not bring back a room deleted while a poll of it was under way", async () => {
            const secret = await rendezvous.createRoom(Room);
            const deletedMidPoll = {
                ...store,
                get: async (room, entry) => {
                    const item = await store.get(room, entry);
                    await rendezvous.deleteRoom(room, secret);
                    return item;
                },
            };
            const racing = createHandler({ store: deletedMidPoll, now: () => clockMs });
            const response = await racing(
                devServerEvent("GET", `${PathPrefix}/room/${Room}/offers`, { headers: { "x-host-secret": secret } }),
            );
            expect(response.statusCode).toBe(200);
            expect(await store.query(Room)).toEqual([]);
        });

        it("keeps rooms apart", async () => {
            await rendezvous.createRoom("one");
            const secretTwo = await rendezvous.createRoom("two");
            await offer("guest1", "sdp", "one");
            expect(await rendezvous.listOffers("two", secretTwo)).toEqual([]);
            await refuses(rendezvous.listOffers("one", secretTwo), 403);
        });
    });

    describe("the host secret", () => {
        let secret;
        beforeEach(async () => {
            secret = await rendezvous.createRoom(Room);
            await offer("guest1");
        });

        it("is required to list offers", async () => {
            expect((await request("GET", `/room/${Room}/offers`)).statusCode).toBe(403);
            await refuses(rendezvous.listOffers(Room, "not-the-secret"), 403);
        });

        it("is required to answer", async () => {
            await refuses(rendezvous.postAnswer(Room, "wrong", "guest1", "ans"), 403);
            expect(await rendezvous.getAnswer(Room, "guest1")).toBeNull();
        });

        it("is required to delete", async () => {
            await refuses(rendezvous.deleteRoom(Room, "wrong"), 403);
            await rendezvous.listOffers(Room, secret);
        });

        it("does not extend a room on a failed poll", async () => {
            advanceSeconds(RoomLifetimeSeconds - 1);
            await refuses(rendezvous.listOffers(Room, "wrong"), 403);
            advanceSeconds(1);
            await refuses(rendezvous.listOffers(Room, secret), 404);
        });
    });

    describe("offers", () => {
        let secret;
        beforeEach(async () => {
            secret = await rendezvous.createRoom(Room);
        });

        const offerMany = async (count) => {
            for (let i = 0; i < count; ++i) await offer(`guest${i}`);
        };

        it("refuses a second live offer from the same guest", async () => {
            await offer("guest1");
            await refuses(offer("guest1"), 409);
        });

        it("expires an offer on its own clock, after which the guest may offer again", async () => {
            await offer("guest1");
            await advanceWhileHostPolls(OfferLifetimeSeconds, secret);
            expect(await rendezvous.listOffers(Room, secret)).toEqual([]);
            await refuses(rendezvous.getAnswer(Room, "guest1"), 404);
            await offer("guest1", "second");
            expect(await rendezvous.getAnswer(Room, "guest1")).toBeNull();
        });

        it("does not let an expired answer stand for a new offer", async () => {
            await offer("guest1");
            await rendezvous.postAnswer(Room, secret, "guest1", "old");
            await advanceWhileHostPolls(OfferLifetimeSeconds, secret);
            await offer("guest1", "again");
            expect(await rendezvous.getAnswer(Room, "guest1")).toBeNull();
            expect(await rendezvous.listOffers(Room, secret)).toEqual([{ guest: "guest1", sdp: "again" }]);
        });

        it(`caps a room at ${MaxPendingOffers} pending offers`, async () => {
            await offerMany(MaxPendingOffers);
            await refuses(offer("onetoomany"), 429);
        });

        it("frees a place under the cap when an offer is answered", async () => {
            await offerMany(MaxPendingOffers);
            await rendezvous.postAnswer(Room, secret, "guest0", "ans");
            await offer("next");
        });

        it("frees a place under the cap when an offer expires", async () => {
            await offerMany(MaxPendingOffers);
            await advanceWhileHostPolls(OfferLifetimeSeconds, secret);
            await offer("next");
        });

        it("refuses an answer to a guest with no live offer", async () => {
            await refuses(rendezvous.postAnswer(Room, secret, "nobody", "ans"), 404);
        });

        it("refuses an offer to a room that never existed", async () => {
            await refuses(offer("guest1", "sdp", "nowhere"), 404);
            await refuses(rendezvous.getAnswer("nowhere", "guest1"), 404);
        });

        it("accepts a plain JSON body, as the function URL passes one", async () => {
            const event = devServerEvent("POST", `${PathPrefix}/room/${Room}/offer`);
            const response = await handler({ ...event, body: JSON.stringify({ guest: "guest1", sdp: "plain" }) });
            expect(response.statusCode).toBe(201);
            expect(await rendezvous.listOffers(Room, secret)).toEqual([{ guest: "guest1", sdp: "plain" }]);
        });
    });

    describe("malformed requests", () => {
        beforeEach(async () => {
            await rendezvous.createRoom(Room);
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
            expect((await request("POST", `/room/${Room}/offer`, { body })).statusCode).toBe(400);
        });

        it("refuses a body over the size cap", async () => {
            await refuses(offer("guest1", "x".repeat(MaxBodyBytes)), 413);
        });

        it.each(["has.dot", "r".repeat(65), "%20"])("refuses the room ID %s", async (room) => {
            expect((await request("POST", `/room/${room}`)).statusCode).toBe(400);
        });

        it("refuses a bad guest ID when reading an answer", async () => {
            await refuses(rendezvous.getAnswer(Room, "bad.id"), 400);
        });

        it.each([["/"], ["/room"], [`/room/${Room}/unknown`], [`/room/${Room}/answer/g/extra`]])(
            "has nothing at %s",
            async (path) => {
                expect((await request("GET", path)).statusCode).toBe(404);
            },
        );

        it("has nothing outside its prefix", async () => {
            expect((await handler(devServerEvent("GET", `/elsewhere/room/${Room}`))).statusCode).toBe(404);
        });

        it.each(["toString", "constructor"])("treats the method %s as any other unknown one", async (method) => {
            expect((await request(method, `/room/${Room}`)).statusCode).toBe(405);
        });

        it("names the allowed methods on a wrong one", async () => {
            const response = await request("PUT", `/room/${Room}`);
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
        const error = await rendezvous.getAnswer(Room, "guest1").catch((e) => e);
        expect(error).toMatchObject({ status: 500, message: expect.stringMatching(/: Internal error$/) });
        expect(logged).toHaveBeenCalledOnce();
    });
});
