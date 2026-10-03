import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MaxBodyBytes, PathPrefix } from "../../rendezvous/handler.js";
import { rendezvousPlugin, toFunctionUrlEvent } from "../../rendezvous/vite-plugin.js";
import { createRendezvousClient } from "../../src/web/rendezvous-client.js";

describe("the dev server's adapter", () => {
    const request = (overrides) => ({
        method: "POST",
        url: "/room/abc/offer?x=1",
        originalUrl: "/api/rendezvous/room/abc/offer?x=1",
        headers: { "x-host-secret": "s3cret", "x-many": ["a", "b"] },
        ...overrides,
    });

    it("carries the path from before the mount point, the query, method and headers", () => {
        expect(toFunctionUrlEvent(request(), Buffer.alloc(0))).toEqual({
            rawPath: "/api/rendezvous/room/abc/offer",
            rawQueryString: "x=1",
            headers: { "x-host-secret": "s3cret", "x-many": "a,b" },
            requestContext: { http: { method: "POST" } },
            body: undefined,
            isBase64Encoded: false,
        });
    });
});

describe("the dev server", () => {
    let vite;
    let http;
    let base;

    beforeAll(async () => {
        vite = await createViteServer({
            configFile: false,
            logLevel: "silent",
            appType: "custom",
            server: { middlewareMode: true, watch: null, ws: false },
            optimizeDeps: { noDiscovery: true, entries: [] },
            plugins: [rendezvousPlugin()],
        });
        http = createHttpServer(vite.middlewares);
        await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${http.address().port}${PathPrefix}`;
    });

    afterAll(async () => {
        await vite.close();
        await new Promise((resolve) => http.close(resolve));
    });

    it("serves the rendezvous from memory under its prefix", async () => {
        const rendezvous = createRendezvousClient({ base });
        const secret = await rendezvous.createRoom("devroom");
        await rendezvous.postOffer("devroom", "guest1", "offer sdp");
        expect(await rendezvous.listOffers("devroom", secret)).toEqual([{ guest: "guest1", sdp: "offer sdp" }]);
    });

    it("refuses a body over the size cap", async () => {
        const response = await fetch(`${base}/room/devroom/offer`, {
            method: "POST",
            body: "x".repeat(MaxBodyBytes * 2),
        });
        expect(response.status).toBe(413);
    });
});
