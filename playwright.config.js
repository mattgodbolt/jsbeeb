import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

import { workersFor } from "./tools/test-workers.js";

// The preview of dist/ the tests drive, on a port of its own so a dev server
// can run alongside. BASE_URL points the suite at a server that is already
// up instead, e.g. BASE_URL=http://localhost:5173/ playwright test --project chrome
const PreviewHost = "127.0.0.1";
const PreviewPort = 5198;
const PreviewUrl = `http://${PreviewHost}:${PreviewPort}/`;
const BaseUrl = process.env.BASE_URL;

// CI's runners have no GPU, so the software renderer is what CI tests. On a
// machine with one, Chrome is pointed at it instead, which takes a filter's
// shader compile from tens of seconds to an instant.
// E2E_GL=software or E2E_GL=hardware overrides the choice.
const RenderNode = "/dev/dri/renderD128";
const GlArgs = {
    software: ["--use-gl=angle", "--use-angle=swiftshader"],
    hardware: ["--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist"],
};
const Gl = process.env.E2E_GL ?? (process.env.CI || !existsSync(RenderNode) ? "software" : "hardware");
if (!GlArgs[Gl]) throw new Error(`E2E_GL must be one of ${Object.keys(GlArgs).join(", ")}, not "${Gl}"`);

export default defineConfig({
    testDir: "tests/playwright",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    // Deliberately none, anywhere: a flake is a bug to root-cause.
    retries: 0,
    // Each worker is a whole Chrome running the machine in real time. One worker
    // per eight hardware threads keeps small machines serial and big ones parallel.
    workers: process.env.CI ? 2 : workersFor(8, 4),
    reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : "list",
    // A hang detector: the dearest test compiles three filters' shaders, which
    // under software GL can run to minutes.
    timeout: 180000,
    expect: { timeout: 10000 },
    use: {
        // Without this a click on a selector that matches nothing waits out
        // the whole test timeout.
        actionTimeout: 30000,
        baseURL: BaseUrl ?? PreviewUrl,
        viewport: { width: 1400, height: 900 },
        trace: "retain-on-failure",
        launchOptions: {
            // Playwright's own headless switches already mute audio and keep
            // shared memory out of /dev/shm; these are what the app needs on top.
            args: [...GlArgs[Gl], "--autoplay-policy=no-user-gesture-required"],
        },
    },
    projects: [
        // The system Chrome: the default, and the only project CI runs.
        { name: "chrome", use: { channel: "chrome" } },
        // For a machine without Chrome; needs `npx playwright install chromium` first.
        { name: "chromium" },
    ],
    webServer: BaseUrl
        ? undefined
        : {
              // vite's own entry point, not npx, so the kill reaches the server itself.
              command: `node node_modules/vite/bin/vite.js preview --host ${PreviewHost} --port ${PreviewPort} --strictPort`,
              url: PreviewUrl,
              reuseExistingServer: !process.env.CI,
          },
});
