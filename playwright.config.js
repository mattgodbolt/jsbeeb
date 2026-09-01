import { defineConfig } from "@playwright/test";

// The preview of dist/ the tests drive, on a port of its own so a dev server
// can run alongside. BASE_URL points the suite at a server that is already
// up instead, e.g. BASE_URL=http://localhost:5173/ playwright test --project chrome
const PreviewHost = "127.0.0.1";
const PreviewPort = 5198;
const PreviewUrl = `http://${PreviewHost}:${PreviewPort}/`;
const BaseUrl = process.env.BASE_URL;

export default defineConfig({
    testDir: "tests/playwright",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    // Deliberately none, anywhere: a flake is a bug to root-cause.
    retries: 0,
    // Each page runs the machine in real time, so the checks that watch it
    // stop and start need CPU of their own: with one worker per core they
    // starve each other and keys auto-repeat.
    workers: process.env.CI ? 2 : 4,
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
            args: ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"],
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
