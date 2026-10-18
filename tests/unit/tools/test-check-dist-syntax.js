import { describe, expect, it } from "vitest";

import { inlineScripts, syntaxError } from "../../../tools/check-dist-syntax.js";

describe("syntaxError", () => {
    it("accepts syntax up to the floor", () => {
        expect(syntaxError("class A { static #x = 1; static { A.#x ||= 2; } }", "module")).toBeNull();
    });

    it("rejects syntax past the floor", () => {
        expect(syntaxError("const re = /[\\p{L}--\\p{Lu}]/v;", "module")).toMatch(/flag/i);
    });

    it("parses a classic script as a script", () => {
        expect(syntaxError("with (a) {}", "script")).toBeNull();
        expect(syntaxError("with (a) {}", "module")).not.toBeNull();
    });
});

describe("inlineScripts", () => {
    it("skips scripts loaded from a URL and keeps each inline script's type", () => {
        const html = `
            <script async src="https://example.com/a.js"></script>
            <script>var a = 1;</script>
            <script type="module" crossorigin src="./assets/index.js"></script>
            <script type="module">import "./b.js";</script>`;
        expect(inlineScripts(html)).toEqual([
            { source: "var a = 1;", sourceType: "script" },
            { source: 'import "./b.js";', sourceType: "module" },
        ]);
    });
});
