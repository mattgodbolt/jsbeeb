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

    it("leaves an include that is not alone on its line", () => {
        const html = `<p><!-- include: ${Fixtures}/inner.html --></p>`;
        expect(stitchIncludes(html, "inline.html")).toBe(html);
    });
});

describe("index.html", () => {
    it("stitches with every include found", () => {
        expect(stitchHtml("index.html")).not.toContain("<!-- include:");
    });
});
