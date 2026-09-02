// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modals } from "../../src/web/modals.js";
import { domFromIndexHtml, teardownDom, toasts } from "./helpers.js";

describe("Modals", () => {
    let loop;
    let modals;

    beforeEach(() => {
        vi.useFakeTimers();
        domFromIndexHtml("error-dialog", "loading-dialog", "are-you-sure", "info", "discs");
        loop = { pause: vi.fn(() => vi.fn()) };
        modals = new Modals({ loop });
    });

    afterEach(teardownDom);

    // The resume handles this test's Modals took, in order. Earlier tests'
    // instances still listen on the shared document, but call their own loop.
    const resumes = () => loop.pause.mock.results.map((result) => result.value);

    // What Bootstrap does around a modal: the events bubble up to the
    // document, and the element carries "show" while it is up.
    const raise = (id) => {
        const el = document.getElementById(id);
        el.dispatchEvent(new Event("show.bs.modal", { bubbles: true }));
        el.classList.add("show");
    };
    const lower = (id) => {
        const el = document.getElementById(id);
        el.classList.remove("show");
        el.dispatchEvent(new Event("hidden.bs.modal", { bubbles: true }));
    };

    describe("holding the emulator", () => {
        it("holds the emulator while a modal is up and lets go when it goes", () => {
            raise("info");
            expect(loop.pause).toHaveBeenCalledTimes(1);
            expect(resumes()[0]).not.toHaveBeenCalled();
            lower("info");
            expect(resumes()[0]).toHaveBeenCalledTimes(1);
        });

        it("takes one hold per modal and lets each go with its own", () => {
            raise("info");
            raise("discs");
            expect(loop.pause).toHaveBeenCalledTimes(2);
            lower("info");
            expect(resumes()[0]).toHaveBeenCalledTimes(1);
            expect(resumes()[1]).not.toHaveBeenCalled();
            lower("discs");
            expect(resumes()[1]).toHaveBeenCalledTimes(1);
        });

        it("does not take a second hold when a modal is shown twice", () => {
            raise("info");
            raise("info");
            expect(loop.pause).toHaveBeenCalledTimes(1);
        });

        it("reports whether any modal is up", () => {
            expect(modals.anyVisible()).toBe(false);
            raise("discs");
            expect(modals.anyVisible()).toBe(true);
            lower("discs");
            expect(modals.anyVisible()).toBe(false);
        });
    });

    describe("showError", () => {
        it("fills in what was being done and what went wrong", () => {
            modals.showError("saving state", "disc full");
            const dialog = document.getElementById("error-dialog");
            expect(dialog.querySelector(".context").textContent).toBe("saving state");
            expect(dialog.querySelector(".error").textContent).toBe("disc full");
        });
    });

    describe("loading dialog", () => {
        it("shows the message", () => {
            modals.popupLoading("Loading Elite");
            expect(document.querySelector("#loading-dialog .loading").textContent).toBe("Loading Elite");
        });

        it("toasts a message on finishing when given one", () => {
            modals.popupLoading("Loading Elite");
            modals.loadingFinished("Unable to load Elite");
            expect(toasts()).toEqual([expect.stringContaining("Unable to load Elite")]);
        });

        it("says nothing on finishing quietly", () => {
            modals.popupLoading("Loading Elite");
            modals.loadingFinished();
            expect(toasts()).toEqual([]);
        });
    });

    describe("confirm", () => {
        const dialog = () => document.getElementById("are-you-sure");

        it("shows the question with the two answers", () => {
            modals.confirm("Restart now?", "Restart", "Later");
            expect(dialog().querySelector(".context").textContent).toBe("Restart now?");
            expect(dialog().querySelector(".ays-yes").textContent).toBe("Restart");
            expect(dialog().querySelector(".ays-no").textContent).toBe("Later");
        });

        it("resolves true once the dialog has gone after yes", async () => {
            const answer = modals.confirm("Restart now?", "Restart", "Later");
            await vi.runAllTimersAsync();
            dialog().querySelector(".ays-yes").click();
            // The real dialog fades, so the hidden event waits on bootstrap's
            // transition timers.
            await vi.runAllTimersAsync();
            await expect(answer).resolves.toBe(true);
            expect(dialog().classList.contains("show")).toBe(false);
        });

        it("resolves false when the dialog is dismissed any other way", async () => {
            const answer = modals.confirm("Restart now?", "Restart", "Later");
            lower("are-you-sure");
            await expect(answer).resolves.toBe(false);
            // A yes from an earlier question must not answer a later one.
            dialog().querySelector(".ays-yes").click();
            await expect(answer).resolves.toBe(false);
        });
    });

    describe("show and hide by id", () => {
        it("ignores an id that is not on the page", () => {
            expect(() => modals.show("no-such-dialog")).not.toThrow();
            expect(() => modals.hide("no-such-dialog")).not.toThrow();
        });
    });
});
