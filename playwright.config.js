import { defineConfig } from "@playwright/test";

// The preview of dist/ the tests drive. A port of its own, so this and
// tests/browser/smoke.js can run side by side.
const PreviewHost = "127.0.0.1";
const PreviewPort = 5198;
const PreviewUrl = `http://${PreviewHost}:${PreviewPort}/`;

export default defineConfig({
    testDir: "tests/playwright",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? [["list"], ["github"]] : "list",
    timeout: 60000,
    expect: { timeout: 10000 },
    use: {
        // Without this a click on a selector that matches nothing waits out
        // the whole test timeout.
        actionTimeout: 10000,
        baseURL: PreviewUrl,
        viewport: { width: 1400, height: 900 },
        trace: "retain-on-failure",
        launchOptions: {
            // Playwright's own headless switches already mute audio and keep
            // shared memory out of /dev/shm; these are what the app needs on top.
            args: ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"],
        },
    },
    projects: [
        // The system Chrome, as the CDP harness and CI use today.
        { name: "chrome", use: { channel: "chrome" } },
        // The build Playwright ships and pins to its own version.
        { name: "chromium" },
    ],
    webServer: {
        // vite's own entry point, not npx, so the kill reaches the server itself.
        command: `node node_modules/vite/bin/vite.js preview --host ${PreviewHost} --port ${PreviewPort} --strictPort`,
        url: PreviewUrl,
        reuseExistingServer: !process.env.CI,
    },
});
