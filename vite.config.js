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
    },
};
