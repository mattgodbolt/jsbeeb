// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { detectKeyboardLayout } from "../../src/keymap.js";

afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

describe("Keyboard layout detection", () => {
    it("detects US keyboard from en-US", () => {
        vi.stubGlobal("navigator", { language: "en-US" });

        expect(detectKeyboardLayout()).toBe("US");
    });

    it("detects UK keyboard from en-GB", () => {
        vi.stubGlobal("navigator", { language: "en-GB" });
        expect(detectKeyboardLayout()).toBe("UK");
    });

    it("defaults to UK for unsupported languages", () => {
        vi.stubGlobal("navigator", { language: "fr-FR" });

        expect(detectKeyboardLayout()).toBe("UK");
    });

    it("ignores the obsolete keyboardLayout storage key", () => {
        window.localStorage.setItem("keyboardLayout", "US");
        vi.stubGlobal("navigator", { language: "en-GB" });

        expect(detectKeyboardLayout()).toBe("UK");
    });
});
