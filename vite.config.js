import { configDefaults } from "vitest/config";

import { defineConfig } from "vitest/config";

/** @type {import("vite").UserConfig} */
export default defineConfig({
    build: {
        sourcemap: true,
        // Prevent inlining; we don't want any worklets/audio workers to be inlined as that doesn't work.
        assetsInlineLimit: 0,
    },
    test: {
        include: [...configDefaults.include, "tests/unit/**/*.js", "tests/integration/**/*.js"],
        testTimout: 15000,
        slowTestThreshold: 1000,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
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
            all: false, // Only track imported files, not all files
        },
    },
});
