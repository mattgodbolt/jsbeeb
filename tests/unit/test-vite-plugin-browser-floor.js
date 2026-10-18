import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { browserFloorPlugin, browserFloors, floorText } from "../../tools/vite-plugin-browser-floor.js";

const IndexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const FloorScript = readFileSync(new URL("../../src/web/browser-floor.js", import.meta.url), "utf8");
const FloorCall = /\nbrowserFloor\((.*)\);\n$/;

describe("browserFloors", () => {
    it("gives each browser's oldest version, with iOS Safari counted as Safari", () => {
        expect(
            browserFloors(["chrome >= 111", "edge >= 111", "firefox >= 115", "safari >= 16.4", "ios_saf >= 15"]),
        ).toEqual({ Chrome: "111", Edge: "111", Firefox: "115", Safari: "15.0" });
    });

    it("compares versions by number, not as text", () => {
        expect(browserFloors(["safari >= 9.1"])).toEqual({ Safari: "9.1" });
    });

    it("refuses a browser it has no name for", () => {
        expect(() => browserFloors(["opera >= 100"])).toThrow(/opera/);
    });
});

describe("floorText", () => {
    it("says a version that browsers share once", () => {
        expect(floorText({ Chrome: "111", Edge: "111", Firefox: "115", Safari: "16.4" })).toBe(
            "Chrome or Edge 111, Firefox 115, or Safari 16.4",
        );
    });

    it("joins two with or", () => {
        expect(floorText({ Chrome: "120", Edge: "121" })).toBe("Chrome 120 or Edge 121");
    });
});

describe("browserFloorPlugin", () => {
    let server;

    const htmlWith = async (measurementId) => {
        server = await createServer({
            configFile: false,
            logLevel: "silent",
            plugins: [browserFloorPlugin(measurementId)],
            server: { middlewareMode: true, hmr: false, ws: false },
        });
        return server.transformIndexHtml("/index.html", IndexHtml);
    };
    const pageWith = async (measurementId) => new JSDOM(await htmlWith(measurementId)).window.document;
    const floorCallIn = (page) =>
        [...page.head.querySelectorAll("script")].find((script) => script.textContent.startsWith(FloorScript));

    afterEach(async () => {
        await server?.close();
        server = undefined;
    });

    it("calls the check from a classic script in the head with package.json's browserslist", async () => {
        const script = floorCallIn(await pageWith(undefined));
        expect(script.type).toBe("");
        expect(JSON.parse(script.textContent.match(FloorCall)[1])).toEqual({
            floors: browserFloors(),
            supported: floorText(),
            measurementId: "",
        });
    });

    it("passes the measurement id when there is one", async () => {
        const script = floorCallIn(await pageWith("G-UNITTEST"));
        expect(JSON.parse(script.textContent.match(FloorCall)[1]).measurementId).toBe("G-UNITTEST");
    });

    // The HTML spec looks for the charset declaration in the first 1024 bytes.
    it("leaves the charset declaration where the browser looks for it", async () => {
        expect((await htmlWith(undefined)).indexOf("<meta charset")).toBeLessThan(1024);
    });

    it("puts a hidden message with a way to get in touch", async () => {
        const message = (await pageWith(undefined)).getElementById("browser-floor");
        expect(message.hidden).toBe(true);
        expect(message.querySelector("#browser-floor-text")).not.toBeNull();
        expect(message.querySelector("a").getAttribute("href")).toBe("mailto:matt@godbolt.org");
    });
});
