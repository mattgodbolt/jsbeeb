import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

import { checkGl, chromeArgs, hasGpu } from "./tools/chrome-gl.js";
import { workersFor } from "./tools/test-workers.js";

// The preview of dist/ the tests drive, on a port derived from this checkout's
// path so parallel worktrees each test their own build. BASE_URL points the
// suite at a server that is already up instead, e.g.
// BASE_URL=http://localhost:5173/ playwright test --project chrome
const PreviewHost = "127.0.0.1";
// Below the ephemeral ranges, so the OS will not hand the port to a client.
const FirstPreviewPort = 20000;
const PreviewPortCount = 10000;
const CheckoutHash = createHash("sha256")
    .update(fileURLToPath(new URL(".", import.meta.url)))
    .digest();
const PreviewPort = FirstPreviewPort + (CheckoutHash.readUInt32BE(0) % PreviewPortCount);
const PreviewUrl = `http://${PreviewHost}:${PreviewPort}/`;
const BaseUrl = process.env.BASE_URL;

// CI's runners have no GPU, so the software renderer is what CI tests. On a
// machine with one, Chrome is pointed at it instead, which takes a filter's
// shader compile from tens of seconds to an instant.
// E2E_GL=software or E2E_GL=hardware overrides the choice.
const Gl = checkGl(process.env.E2E_GL ?? (process.env.CI || !hasGpu() ? "software" : "hardware"), "E2E_GL");

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
    timeout: 60000,
    expect: { timeout: 10000 },
    use: {
        // Without this a click on a selector that matches nothing waits out
        // the whole test timeout.
        actionTimeout: 10000,
        baseURL: BaseUrl ?? PreviewUrl,
        viewport: { width: 1400, height: 900 },
        trace: "retain-on-failure",
        launchOptions: {
            // Playwright's own headless switches already mute audio and keep
            // shared memory out of /dev/shm; these are what the app needs on top.
            args: chromeArgs(Gl),
        },
    },
    projects: [
        // The system Chrome: the default, and the only project CI runs.
        { name: "chrome", use: { channel: "chrome" } },
        // For a machine without Chrome; needs `npx playwright install chromium` first.
        { name: "chromium" },
        // Playwright's patched engines, not branded Firefox or Safari; each needs `npx playwright install` first.
        // An empty launchOptions leaves out the Chrome switches above.
        { name: "firefox", use: { browserName: "firefox", launchOptions: {} } },
        { name: "webkit", use: { browserName: "webkit", launchOptions: {} } },
    ],
    webServer: BaseUrl
        ? undefined
        : {
              // vite's own entry point, not npx, so the kill reaches the server itself.
              command: `node node_modules/vite/bin/vite.js preview --host ${PreviewHost} --port ${PreviewPort} --strictPort`,
              url: PreviewUrl,
              // Nothing already listening is known to serve this checkout's dist/,
              // so a clash fails rather than testing some other build.
              reuseExistingServer: false,
          },
});
