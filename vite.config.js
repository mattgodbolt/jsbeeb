import { configDefaults, defineConfig } from "vitest/config";
import { firShaderPlugin } from "./tools/vite-plugin-fir-shader.js";
import { workersFor } from "./tools/test-workers.js";

// Every run in a GitHub Actions job appends to one summary page, so the suites need headings of
// their own. The title is a root option rather than a per-project one, so the workflow names each
// run as it starts it.
const JobSummaryTitle = process.env.VITEST_JOB_SUMMARY_TITLE;

/** @type {import("vite").UserConfig} */
export default defineConfig({
    base: "./", // Use relative paths for Electron compatibility
    plugins: [firShaderPlugin()],
    build: {
        sourcemap: true,
        // Prevent inlining; we don't want any worklets/audio workers to be inlined as that doesn't work.
        assetsInlineLimit: 0,
    },
    test: {
        testTimeout: 15000,
        // Transformed modules persist in node_modules/.vitest-cache, so each run reuses the last
        // one's work rather than transforming the graph again. Reinstalling deps clears it.
        fsModuleCache: true,
        ...(JobSummaryTitle
            ? { reporters: ["default", ["github-actions", { jobSummary: { title: JobSummaryTitle } }]] }
            : {}),
        // Every worker runs CPU-bound JavaScript (an emulated machine, or jsdom),
        // so a hyperthread sibling would only share its core: one worker per two
        // threads.
        maxWorkers: workersFor(2),
        projects: [
            { extends: true, test: { name: "unit", include: ["tests/unit/**/test-*.js"] } },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["tests/integration/**/*.js"],
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
            ],
        },
    },
});
