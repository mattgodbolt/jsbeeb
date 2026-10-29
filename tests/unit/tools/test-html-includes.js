import { describe, expect, it } from "vitest";

import { stitchHtml, stitchIncludes } from "../../../tools/html-includes.js";

const Fixtures = "tests/unit/tools/html-includes";

describe("stitchHtml", () => {
    it("expands includes inside included files", () => {
        expect(stitchHtml(`${Fixtures}/page.html`)).toBe("<main>\n<section>\n<p>inner</p>\n</section>\n</main>\n");
    });

    it("leaves a file without includes as it is", () => {
        expect(stitchHtml(`${Fixtures}/inner.html`)).toBe("<p>inner</p>\n");
    });

    it("names the including file and the missing one", () => {
        expect(() => stitchHtml(`${Fixtures}/missing.html`)).toThrow(
            `${Fixtures}/missing.html includes ${Fixtures}/absent.html, which does not exist`,
        );
    });

    it("refuses a file that includes itself", () => {
        expect(() => stitchHtml(`${Fixtures}/cycle.html`)).toThrow(/include cycle/);
    });

    it("expands an include on a line ending in CRLF", () => {
        const html = `<main>\r\n  <!-- include: ${Fixtures}/inner.html -->\r\n</main>\r\n`;
        expect(stitchIncludes(html, "inline.html")).toBe("<main>\r\n<p>inner</p>\n</main>\r\n");
    });

    it.each([
        ["not alone on its line", `<p><!-- include: ${Fixtures}/inner.html --></p>`],
        ["without the spaces", `<!--include:${Fixtures}/inner.html-->`],
        ["in capitals", `<!-- INCLUDE: ${Fixtures}/inner.html -->`],
    ])("refuses an include %s, naming the file and line", (_how, include) => {
        expect(() => stitchIncludes(`<main>\n${include}\n</main>`, "inline.html")).toThrow(/^inline\.html:2: /);
    });

    it("names the partial that holds a malformed include", () => {
        expect(() => stitchHtml(`${Fixtures}/malformed-outer.html`)).toThrow(`${Fixtures}/malformed.html:1: `);
    });
});

describe("index.html", () => {
    it("stitches with every include found", () => {
        expect(stitchHtml("index.html")).not.toContain("<!-- include:");
    });
});
