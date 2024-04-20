import prettier from "eslint-plugin-prettier";
import eslintConfigPrettier from "eslint-config-prettier";
import js from "@eslint/js";
import globals from "globals";

export default [
    js.configs.recommended,
    eslintConfigPrettier,
    {
        plugins: { prettier },
        // env: {
        //     browser: true,
        //     amd: true,
        //     commonjs: true,
        //     es2021: true,
        //     node: true
        // },
        ignores: ["lib/", "out/"],
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
    },
];
