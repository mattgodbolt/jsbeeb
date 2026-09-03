import { configDefaults, defineConfig } from "vitest/config";
import { firShaderPlugin } from "./tools/vite-plugin-fir-shader.js";
import { workersFor } from "./tools/test-workers.js";

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
