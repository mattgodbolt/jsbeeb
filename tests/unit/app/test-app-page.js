import { describe, expect, it } from "vitest";

import { isAppPage } from "../../../src/app/app-page.js";

const AppPage = "/opt/jsbeeb/dist/index.html";
const mainFrame = (url) => {
    const frame = { url };
    return { senderFrame: frame, sender: { mainFrame: frame } };
};

describe("the app's own page", () => {
    it.each([
        ["file:///opt/jsbeeb/dist/index.html", true],
        ["file:///opt/jsbeeb/dist/index.html?vdfs=1&disc1=file%3A%2F%2F%2Fa.ssd#top", true],
        ["https://example.com/opt/jsbeeb/dist/index.html", false],
        ["http://www.example.com/", false],
        ["file:///tmp/evil/index.html", false],
        ["file:///opt/jsbeeb/dist/other.html", false],
        ["not a url", false],
    ])("is told from another page by its address: %s is %s", (url, expected) => {
        expect(isAppPage(mainFrame(url), AppPage)).toBe(expected);
    });

    it("is not a frame inside it, or a message with no frame", () => {
        const frame = { url: "file:///opt/jsbeeb/dist/index.html" };
        expect(isAppPage({ senderFrame: frame, sender: { mainFrame: { url: frame.url } } }, AppPage)).toBe(false);
        expect(isAppPage({ sender: {} }, AppPage)).toBe(false);
    });
});
