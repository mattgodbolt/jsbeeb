import { beforeEach, describe, expect, it } from "vitest";

import { createHandler } from "../../rendezvous/handler.js";
import { createMemoryStore } from "../../rendezvous/memory-store.js";
import { createRendezvousClient, RendezvousError } from "../../src/web/rendezvous-client.js";

function fetchThrough(handler) {
    return async (url, { method, headers, body }) => {
        const { pathname, search } = new URL(url, "http://localhost");
        const response = await handler({
            rawPath: pathname,
            rawQueryString: search.slice(1),
            headers,
            requestContext: { http: { method } },
            body,
            isBase64Encoded: false,
        });
        return new Response(response.body, { status: response.statusCode, headers: response.headers });
    };
}

describe("rendezvous client", () => {
    let client;

    beforeEach(() => {
        const handler = createHandler({ store: createMemoryStore() });
        client = createRendezvousClient({ fetch: fetchThrough(handler) });
    });

    it("runs the host and guest flow", async () => {
        const secret = await client.createRoom("room1");
        await client.postOffer("room1", "guest1", "offer sdp");
        expect(await client.getAnswer("room1", "guest1")).toBeNull();
        expect(await client.listOffers("room1", secret)).toEqual([{ guest: "guest1", sdp: "offer sdp" }]);
        await client.postAnswer("room1", secret, "guest1", "answer sdp");
        expect(await client.getAnswer("room1", "guest1")).toBe("answer sdp");
        expect(await client.listOffers("room1", secret)).toEqual([]);
        await client.deleteRoom("room1", secret);
        await expect(client.getAnswer("room1", "guest1")).rejects.toThrow(RendezvousError);
    });

    it("throws with the status and the server's reason", async () => {
        await client.createRoom("room1");
        const error = await client.createRoom("room1").catch((e) => e);
        expect(error).toBeInstanceOf(RendezvousError);
        expect(error.status).toBe(409);
        expect(error.message).toBe("Rendezvous create room failed with status 409: Room already exists");
    });

    it("passes on a refusal of the host secret", async () => {
        await client.createRoom("room1");
        await expect(client.listOffers("room1", "wrong")).rejects.toMatchObject({ status: 403 });
    });

    it("uses the base it is given", async () => {
        const urls = [];
        const recording = createRendezvousClient({
            base: "https://example.test/api/rendezvous",
            fetch: async (url) => {
                urls.push(url);
                return new Response(JSON.stringify({ secret: "s" }), { status: 201 });
            },
        });
        expect(await recording.createRoom("my room")).toBe("s");
        expect(urls).toEqual(["https://example.test/api/rendezvous/room/my%20room"]);
    });

    it("copes with a response that is not JSON", async () => {
        const broken = createRendezvousClient({
            fetch: async () => new Response("<html>Bad gateway</html>", { status: 502 }),
        });
        await expect(broken.postOffer("r", "g", "sdp")).rejects.toThrow("Rendezvous post offer failed with status 502");
    });
});
