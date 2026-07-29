// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeAreYouSure } from "../../src/are-you-sure.js";

// The tests drive the shipped markup rather than a hand-written fixture, so they notice if the
// dialog's classes drift away from what the code expects.
const indexHtml = readFileSync("index.html", "utf8");

/** Stands in for the bootstrap modal, whose showing and hiding jsdom knows nothing about. */
class FakeModal {
    constructor(element) {
        this.element = element;
        this.shown = false;
    }

    show() {
        this.shown = true;
    }

    hide() {
        this.shown = false;
        this.element.dispatchEvent(new Event("hidden.bs.modal"));
    }
}

describe("areYouSure", () => {
    let element;
    let modal;
    let areYouSure;
    let yes;

    beforeEach(() => {
        document.body.innerHTML = indexHtml;
        element = document.getElementById("are-you-sure");
        modal = new FakeModal(element);
        areYouSure = makeAreYouSure(element, modal);
        yes = vi.fn();
        areYouSure("Restart now?", "Restart now", "Later", yes);
    });

    it("shows the question and the button labels", () => {
        expect(modal.shown).toBe(true);
        expect(element.querySelector(".context").textContent).toBe("Restart now?");
        expect(element.querySelector(".ays-yes").textContent).toBe("Restart now");
        expect(element.querySelector(".ays-no").textContent).toBe("Later");
    });

    it("runs the callback once the modal has hidden after a yes", () => {
        element.querySelector(".ays-yes").click();

        expect(yes).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the no button dismisses the modal", () => {
        element.querySelector(".ays-no").click();
        modal.hide();

        expect(yes).not.toHaveBeenCalled();
    });

    it("does nothing when the modal is dismissed some other way", () => {
        // Escape, a click outside and the close button all reach us only as the modal hiding.
        modal.hide();

        expect(yes).not.toHaveBeenCalled();
    });

    it("does not answer a later question with an earlier yes", () => {
        element.querySelector(".ays-yes").click();
        const secondYes = vi.fn();
        areYouSure("Again?", "Yes", "No", secondYes);
        modal.hide();

        expect(yes).toHaveBeenCalledTimes(1);
        expect(secondYes).not.toHaveBeenCalled();
    });
});
