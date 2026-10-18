import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { browserFloorPlugin, floorText } from "../../tools/vite-plugin-browser-floor.js";

const IndexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const FloorScript = readFileSync(new URL("../../src/browser-floor.js", import.meta.url), "utf8");

describe("floorText", () => {
    it("names each browser's oldest version, saying a shared version once", () => {
        expect(floorText(["chrome >= 111", "edge >= 111", "firefox >= 115", "safari >= 16.4", "ios_saf >= 16.4"])).toBe(
            "Chrome or Edge 111, Firefox 115, or Safari 16.4",
        );
    });

    it("keeps apart versions that differ", () => {
        expect(floorText(["chrome >= 120", "edge >= 121"])).toBe("Chrome 120 or Edge 121");
    });

    it("compares versions by number, not as text", () => {
        expect(floorText(["safari >= 9.1"])).toBe("Safari 9.1");
    });

    it("refuses a browser it has no name for", () => {
        expect(() => floorText(["opera >= 100"])).toThrow(/opera/);
    });
});

describe("browserFloorPlugin", () => {
    let server;

    const pageWith = async (measurementId) => {
        server = await createServer({
            configFile: false,
            logLevel: "silent",
            plugins: [browserFloorPlugin(measurementId)],
            server: { middlewareMode: true, hmr: false, ws: false },
        });
        const html = await server.transformIndexHtml("/index.html", IndexHtml);
        return new JSDOM(html).window.document;
    };

    afterEach(async () => {
        await server?.close();
        server = undefined;
    });

    it("runs the check before the module bundle", async () => {
        const page = await pageWith(undefined);
        const scripts = [...page.querySelectorAll("script")];
        const check = scripts.findIndex((script) => script.textContent === FloorScript);
        expect(check).toBeGreaterThan(-1);
        expect(scripts[check].type).toBe("");
        expect(check).toBeLessThan(scripts.findIndex((script) => script.type === "module"));
    });

    it("puts a hidden message with the versions from package.json's browserslist and a way to get in touch", async () => {
        const message = (await pageWith(undefined)).getElementById("browser-floor");
        expect(message.hidden).toBe(true);
        expect(message.textContent).toContain(`It needs ${floorText()} or newer.`);
        expect(message.querySelector("a").getAttribute("href")).toBe("mailto:matt@godbolt.org");
        expect(message.querySelector("#browser-floor-browser")).not.toBeNull();
        expect(message.querySelector("#browser-floor-close")).not.toBeNull();
    });

    it("gives the message the measurement id only when there is one", async () => {
        expect((await pageWith(undefined)).getElementById("browser-floor").dataset.measurementId).toBeUndefined();
        await server.close();
        expect((await pageWith("G-UNITTEST")).getElementById("browser-floor").dataset.measurementId).toBe("G-UNITTEST");
    });
});
