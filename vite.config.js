import { configDefaults } from "vitest/config";

/** @type {import('vite').UserConfig} */
export default {
    build: {
        sourcemap: true,
    },
    test: {
        include: [...configDefaults.include, "tests/unit/**/*.js", "tests/integration/**/*.js"],
    },
};
