import { configDefaults } from "vitest/config";

import { defineConfig } from "vitest/config";
import { firShaderPlugin } from "./tools/vite-plugin-fir-shader.js";

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
        include: [
            ...configDefaults.include,
            "tests/unit/**/test-*.js",
            "tests/integration/**/*.js",
            "tests/shader/test-*.js",
        ],
        testTimeout: 15000,
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
