import { configDefaults } from "vitest/config";

/** @type {import("vite").UserConfig} */
export default {
    build: {
        sourcemap: true,
        // Prevent inlining; we don't want any worklets/audio workers to be inlined as that doesn't work.
        assetsInlineLimit: 0,
    },
    test: {
        include: [...configDefaults.include, "tests/unit/**/*.js", "tests/integration/**/*.js"],
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
};
