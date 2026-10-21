import { get } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseOptions, serve, throughput } from "../../../tools/browser-ab.js";

const Projects = [
    { name: "chrome", use: { channel: "chrome" } },
    { name: "firefox", use: { browserName: "firefox" } },
];

describe("parseOptions", () => {
    it("reads the sides, the workloads and the defaults", () => {
        expect(parseOptions(["main", "HEAD", "elite"], Projects)).toMatchObject({
            specs: ["main", "HEAD"],
            workloads: ["elite"],
            project: "chrome",
            browserName: "chromium",
            channel: "chrome",
            gl: "software",
            fresh: "context",
            pass: "full",
            statistic: "median",
            minPairs: 8,
            maxPairs: 30,
            horizon: 0.02,
            profileSides: [],
        });
    });

    it("takes the browser from the named project", () => {
        expect(parseOptions(["a", "b", "--project", "firefox"], Projects)).toMatchObject({
            browserName: "firefox",
            channel: undefined,
        });
    });

    it.each([
        [["main"], "Name two sides"],
        [["a", "b", "--project", "safari"], '--project is one of chrome, firefox, not "safari"'],
        [["a", "b", "--gl", "gpu"], '--gl must be one of software, hardware, not "gpu"'],
        [["a", "b", "--fresh", "page"], '--fresh is one of context, browser, not "page"'],
        [["a", "b", "--pass", "copy"], '--pass is one of full, video, cpu, not "copy"'],
        [["a", "b", "--statistic", "mean"], '--statistic is one of median, total, not "mean"'],
        [["a", "b", "--cpu-prof", "c"], '--cpu-prof takes a, b or both, not "c"'],
        [["a", "b", "--project", "firefox", "--cpu-prof", "a"], "--cpu-prof needs Chrome's profiler, not firefox"],
        [["a", "b", "--max-pairs", "7"], "--max-pairs takes a whole number of at least 8"],
    ])("refuses %j before anything runs", (args, message) => {
        expect(() => parseOptions(args, Projects)).toThrow(message);
    });
});

describe("throughput", () => {
    const secondsMs = [200, 400, 400];
    const result = {
        mhz: 2 / 0.4,
        passes: { full: { ms: { median: 400 } }, cpu: { ms: { median: 100 } } },
        samples: { full: secondsMs.map((ms) => ({ ms })), cpu: [{ ms: 100 }] },
    };

    it("is the pass's median emulated second in virtual MHz", () => {
        expect(throughput(result, "full", "median")).toBeCloseTo(5, 10);
        expect(throughput(result, "cpu", "median")).toBeCloseTo(20, 10);
    });

    it("counts every second's time with the total statistic", () => {
        expect(throughput(result, "full", "total")).toBeCloseTo(2e6 / (1000 / 3) / 1000, 10);
    });
});

describe("serve", () => {
    let dir;
    let server;
    beforeEach(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), "test-browser-ab-"));
        mkdirSync(path.join(dir, "site", "benchmarks"), { recursive: true });
        writeFileSync(path.join(dir, "site", "index.html"), "<p>page</p>");
        writeFileSync(path.join(dir, "site", "benchmarks", "elite.json.gz"), "gz");
        writeFileSync(path.join(dir, "secret.txt"), "outside");
        server = await serve(path.join(dir, "site"));
    });
    afterEach(() => {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it("serves the folder's index and files with their types", async () => {
        const index = await fetch(server.url);
        expect(index.headers.get("content-type")).toBe("text/html");
        expect(await index.text()).toBe("<p>page</p>");
        const snapshot = await fetch(`${server.url}benchmarks/elite.json.gz`);
        expect(snapshot.headers.get("content-type")).toBe("application/gzip");
        expect(snapshot.headers.get("content-encoding")).toBeNull();
    });

    // fetch would resolve the dots before sending; http sends the path as it is.
    const statusOf = (requestPath) =>
        new Promise((resolve, reject) => {
            const { hostname, port } = new URL(server.url);
            get({ hostname, port, path: requestPath }, (response) => {
                response.resume();
                resolve(response.statusCode);
            }).on("error", reject);
        });

    it("serves nothing outside the folder", async () => {
        expect(await statusOf("/../secret.txt")).toBe(404);
        expect(await statusOf("/%2e%2e%2fsecret.txt")).toBe(403);
        expect((await fetch(`${server.url}missing.js`)).status).toBe(404);
    });
});
