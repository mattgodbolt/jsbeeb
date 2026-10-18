import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsPlugin } from "../../tools/vite-plugin-analytics.js";

const IndexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

const cspOf = (html) => html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)[1];

describe("analyticsPlugin", () => {
    let server;

    const pageWith = async (measurementId) => {
        server = await createServer({
            configFile: false,
            logLevel: "silent",
            plugins: [analyticsPlugin(measurementId)],
            server: { middlewareMode: true, hmr: false, ws: false },
        });
        return server.transformIndexHtml("/index.html", IndexHtml);
    };

    beforeEach(() => {
        vi.stubEnv("GA_MEASUREMENT_ID", undefined);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await server?.close();
        server = undefined;
    });

    it.each([undefined, ""])("puts nothing of Google's on the page when the id is %j", async (measurementId) => {
        const html = await pageWith(measurementId);
        expect(html).not.toContain("googletagmanager");
        expect(html).not.toContain("gtag(");
        expect(html).not.toContain("dataLayer");
        expect(cspOf(html)).toBe("script-src 'self' 'unsafe-inline' 'unsafe-eval';");
    });

    it.each([undefined, ""])("gives analytics.js an empty id when the id is %j", (measurementId) => {
        expect(analyticsPlugin(measurementId).config().define).toEqual({ "import.meta.env.GA_MEASUREMENT_ID": '""' });
    });

    describe("with an id", () => {
        const measurementId = "G-UNITTEST";

        it("loads gtag.js for the id and defines the gtag stub, ahead of the CSP", async () => {
            const html = await pageWith(measurementId);
            const loader = html.indexOf(`src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"`);
            const stub = html.indexOf("function gtag()");
            const csp = html.indexOf("Content-Security-Policy");
            expect(loader).toBeGreaterThan(-1);
            expect(stub).toBeGreaterThan(-1);
            expect(loader).toBeLessThan(csp);
            expect(stub).toBeLessThan(csp);
        });

        it("lets Google's analytics hosts through the CSP", async () => {
            expect(cspOf(await pageWith(measurementId))).toBe(
                "script-src 'self' 'unsafe-inline' 'unsafe-eval' *.google-analytics.com *.google.com;",
            );
        });

        it("gives analytics.js the id", () => {
            expect(analyticsPlugin(measurementId).config().define).toEqual({
                "import.meta.env.GA_MEASUREMENT_ID": JSON.stringify(measurementId),
            });
        });

        it("fails the build when the CSP has no script-src to extend", () => {
            const { transformIndexHtml } = analyticsPlugin(measurementId);
            expect(() => transformIndexHtml("<html><head></head></html>")).toThrow(/script-src/);
        });
    });
});
