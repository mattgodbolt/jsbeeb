import { describe, expect, it } from "vitest";

import { createRendezvousClient } from "../../src/web/rendezvous-client.js";

describe("rendezvous client", () => {
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

    it("asks for a delete that outlives the page, since a host deletes its room as it goes", async () => {
        const requests = [];
        const recording = createRendezvousClient({
            fetch: async (url, init) => {
                requests.push(init);
                return new Response("{}", { status: 200 });
            },
        });
        await recording.deleteRoom("room", "secret");
        await recording.listOffers("room", "secret").catch(() => {});
        expect(requests.map((init) => init.keepalive)).toEqual([true, false]);
    });

    it("copes with a response that is not JSON", async () => {
        const broken = createRendezvousClient({
            fetch: async () => new Response("<html>Bad gateway</html>", { status: 502 }),
        });
        await expect(broken.postOffer("r", "g", "sdp")).rejects.toThrow("Rendezvous post offer failed with status 502");
    });
});
