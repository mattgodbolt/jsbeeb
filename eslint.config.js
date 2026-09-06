import prettier from "eslint-plugin-prettier";
import eslintConfigPrettier from "eslint-config-prettier";
import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: ["lib/", "out/", "dist/", "coverage/"],
    },
    js.configs.recommended,
    eslintConfigPrettier,
    {
        plugins: { prettier },
        languageOptions: {
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: "module",
            },
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            "no-unused-vars": [
                "error",
                {
                    varsIgnorePattern: "^_",
                    argsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },
    // The core of the emulator runs headless as well as in the page, so it sees only what node and
    // browsers share; the browser belongs to src/web, src/main.js and the vendored GL debugger.
    {
        files: ["src/**/*.js"],
        ignores: ["src/web/**", "src/app/**", "src/main.js", "src/lib/**"],
        languageOptions: { globals: { ...globals.node, ...globals["shared-node-browser"] } },
    },
    {
        files: ["src/loader.js"],
        languageOptions: { globals: { XMLHttpRequest: "readonly" } },
    },
];
