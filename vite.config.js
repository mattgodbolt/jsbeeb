import { execFileSync } from "node:child_process";
import browserslistToEsbuild from "browserslist-to-esbuild";
import { configDefaults, defineConfig } from "vitest/config";
import { firShaderPlugin } from "./tools/vite-plugin-fir-shader.js";
import { rendezvousPlugin } from "./rendezvous/vite-plugin.js";
import { analyticsPlugin } from "./tools/vite-plugin-analytics.js";
import { browserFloorPlugin } from "./tools/vite-plugin-browser-floor.js";
import { workersFor } from "./tools/test-workers.js";

// Every run in a GitHub Actions job appends to one summary page, so the suites need headings of
// their own. The title is a root option rather than a per-project one, so the workflow names each
// run as it starts it.
const JobSummaryTitle = process.env.VITEST_JOB_SUMMARY_TITLE;

const FastWaitFor = "tests/fast-wait-for.js";

// What the benchmark page reports a build as: the commit, with "-dirty" for uncommitted changes.
function gitCommit() {
    try {
        return execFileSync("git", ["describe", "--always", "--dirty", "--exclude=*"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return "unknown";
    }
}

/** @type {import("vite").UserConfig} */
export default defineConfig({
    base: "./", // Use relative paths for Electron compatibility
    plugins: [firShaderPlugin(), rendezvousPlugin(), analyticsPlugin(), browserFloorPlugin()],
    define: { "import.meta.env.JSBEEB_COMMIT": JSON.stringify(gitCommit()) },
    build: {
        target: browserslistToEsbuild(),
        sourcemap: true,
        // Prevent inlining; we don't want any worklets/audio workers to be inlined as that doesn't work.
        assetsInlineLimit: 0,
    },
    test: {
        testTimeout: 15000,
        fsModuleCache: true,
        ...(JobSummaryTitle
            ? { reporters: ["default", ["github-actions", { jobSummary: { title: JobSummaryTitle } }]] }
            : {}),
        // Every worker runs CPU-bound JavaScript (an emulated machine, or jsdom),
        // so a hyperthread sibling would only share its core: one worker per two
        // threads.
        maxWorkers: workersFor(2),
        projects: [
            { extends: true, test: { name: "unit", include: ["tests/unit/**/test-*.js"], setupFiles: [FastWaitFor] } },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["tests/integration/**/*.js"],
                    setupFiles: [FastWaitFor],
                    exclude: [...configDefaults.exclude, "tests/integration/helpers.js", "tests/integration/png.js"],
                    // A hang detector; the dearest test costs under ten seconds uncontended.
                    testTimeout: 120000,
                },
            },
            { extends: true, test: { name: "shader", include: ["tests/shader/test-*.js"] } },
        ],
        slowTestThreshold: 1000,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov", "json", "json-summary"],
            include: [
                "src/**/*.js", // Only include project source files
            ],
            exclude: [
                "tests/**",
                "node_modules/**",
                "src/lib/**", // Third-party libraries
                "**/*.config.js",
                "src/app/**", // App-specific code
                "src/web/browser-floor.js", // Put on the page as text, never imported
            ],
        },
    },
});
