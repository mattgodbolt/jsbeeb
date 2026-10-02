import { describe, expect, it } from "vitest";

import { toFunctionUrlEvent } from "../../rendezvous/vite-plugin.js";

describe("toFunctionUrlEvent", () => {
    const request = (overrides) => ({
        method: "POST",
        url: "/room/abc/offer?x=1",
        originalUrl: "/api/rendezvous/room/abc/offer?x=1",
        headers: { "x-host-secret": "s3cret", "x-many": ["a", "b"] },
        ...overrides,
    });

    it("carries the path from before the mount point, the query, method and headers", () => {
        const event = toFunctionUrlEvent(request(), Buffer.alloc(0));
        expect(event).toEqual({
            rawPath: "/api/rendezvous/room/abc/offer",
            rawQueryString: "x=1",
            headers: { "x-host-secret": "s3cret", "x-many": "a,b" },
            requestContext: { http: { method: "POST" } },
            body: undefined,
            isBase64Encoded: false,
        });
    });

    it("passes the body as base64", () => {
        const event = toFunctionUrlEvent(request(), Buffer.from('{"guest":"g"}'));
        expect(event.isBase64Encoded).toBe(true);
        expect(Buffer.from(event.body, "base64").toString()).toBe('{"guest":"g"}');
    });
});
