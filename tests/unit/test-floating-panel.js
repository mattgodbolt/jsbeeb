// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingPanel } from "../../src/web/floating-panel.js";
import { teardownDom } from "./helpers.js";

describe("FloatingPanel", () => {
    let panel;
    let header;
    let closeButton;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="p" hidden>
                <div class="header"><button id="close">Close</button></div>
                <button id="inside">Inside</button>
            </div>`;
        panel = document.getElementById("p");
        header = panel.querySelector(".header");
        closeButton = document.getElementById("close");
        header.setPointerCapture = () => {};
        panel.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100 });
    });

    afterEach(teardownDom);

    const make = () => new FloatingPanel({ panel, header, closeButton });
    const events = (floating) => {
        const seen = [];
        for (const type of ["open", "close"]) floating.addEventListener(type, () => seen.push(type));
        return seen;
    };

    it("starts closed and opens, closes and toggles, saying so once per change", () => {
        const floating = make();
        const seen = events(floating);
        expect(floating.isOpen).toBe(false);
        floating.open();
        floating.open();
        expect(panel.hidden).toBe(false);
        floating.toggle();
        expect(panel.hidden).toBe(true);
        floating.close();
        expect(seen).toEqual(["open", "close"]);
    });

    it("closes from its button and from Escape pressed inside it", () => {
        const floating = make();
        floating.open();
        closeButton.click();
        expect(floating.isOpen).toBe(false);
        floating.open();
        const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
        document.getElementById("inside").dispatchEvent(escape);
        expect(floating.isOpen).toBe(false);
    });

    it("lets go of the keyboard focus when it closes", () => {
        const floating = make();
        floating.open();
        const inside = document.getElementById("inside");
        inside.focus();
        expect(document.activeElement).toBe(inside);
        floating.close();
        expect(document.activeElement).toBe(document.body);
    });

    it("is dragged by its header and kept inside the window", () => {
        make();
        header.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 110, clientY: 60 }));
        header.dispatchEvent(new MouseEvent("pointermove", { clientX: 130, clientY: 75 }));
        expect(panel.style.left).toBe("120px");
        expect(panel.style.top).toBe("65px");
        expect(panel.style.right).toBe("auto");
        header.dispatchEvent(new MouseEvent("pointermove", { clientX: 5, clientY: 5 }));
        expect(panel.style.left).toBe("0px");
        expect(panel.style.top).toBe("0px");
        header.dispatchEvent(new MouseEvent("pointermove", { clientX: 5000, clientY: 5000 }));
        expect(panel.style.left).toBe(`${window.innerWidth - 200}px`);
        expect(panel.style.top).toBe(`${window.innerHeight - 100}px`);
    });

    it("ignores a drag that starts on a button in the header, or with another mouse button", () => {
        make();
        closeButton.dispatchEvent(
            new MouseEvent("pointerdown", { button: 0, clientX: 110, clientY: 60, bubbles: true }),
        );
        header.dispatchEvent(new MouseEvent("pointermove", { clientX: 130, clientY: 75 }));
        header.dispatchEvent(new MouseEvent("pointerdown", { button: 2, clientX: 110, clientY: 60 }));
        header.dispatchEvent(new MouseEvent("pointermove", { clientX: 130, clientY: 75 }));
        expect(panel.style.left).toBe("");
    });

    it("stays inside the window when the window shrinks", () => {
        const floating = make();
        floating.open();
        header.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 110, clientY: 60 }));
        header.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 500 }));
        vi.spyOn(window, "innerWidth", "get").mockReturnValue(500);
        vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
        window.dispatchEvent(new Event("resize"));
        expect(panel.style.left).toBe("300px");
        expect(panel.style.top).toBe("200px");
    });
});
