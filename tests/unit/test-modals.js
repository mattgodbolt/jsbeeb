// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modals } from "../../src/web/modals.js";
import { domFromIndexHtml, sentEvents, teardownDom } from "./helpers.js";

describe("Modals", () => {
    let loop;
    let modals;

    beforeEach(() => {
        vi.useFakeTimers();
        domFromIndexHtml("error-dialog", "are-you-sure", "info", "help");
        loop = { hold: vi.fn(() => vi.fn()) };
        modals = new Modals({ loop });
    });

    afterEach(teardownDom);

    // The resume handles this test's Modals took, in order. Earlier tests'
    // instances still listen on the shared document, but call their own loop.
    const resumes = () => loop.hold.mock.results.map((result) => result.value);

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
        it("holds the emulator once per modal while it is up, and lets each go with its own", () => {
            raise("info");
            raise("help");
            expect(loop.hold.mock.calls).toEqual([["the info dialog"], ["the help dialog"]]);
            lower("info");
            expect(resumes()[0]).toHaveBeenCalledTimes(1);
            expect(resumes()[1]).not.toHaveBeenCalled();
            lower("help");
            expect(resumes()[1]).toHaveBeenCalledTimes(1);
        });

        it("does not take a second hold when a modal is shown twice", () => {
            raise("info");
            raise("info");
            expect(loop.hold).toHaveBeenCalledTimes(1);
        });

        const afterTheDialogFades = async (next) => {
            modals.hide("info");
            await vi.advanceTimersToNextTimerAsync();
            modals.show(next);
        };
        const fromTheHideEvent = async (next) => {
            document.getElementById("info").addEventListener("hide.bs.modal", () => modals.show(next), { once: true });
            modals.hide("info");
        };

        it.each([
            ["the same modal", "info", afterTheDialogFades],
            ["another modal", "help", afterTheDialogFades],
            ["another modal from the hide itself", "help", fromTheHideEvent],
        ])(
            "shows %s raised while a modal is closing once it has closed, whole and held",
            async (_, next, raiseWhileClosing) => {
                const holding = [];
                loop.hold.mockImplementation(() => {
                    holding.push("hold");
                    return () => holding.push("let go");
                });
                modals.show("info");
                await vi.runAllTimersAsync();
                window.addEventListener("hidden.bs.modal", () => holding.push("hidden handled"), { once: true });
                await raiseWhileClosing(next);
                await vi.runAllTimersAsync();
                expect([...document.querySelectorAll(".modal.show")]).toEqual([document.getElementById(next)]);
                expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(1);
                expect(document.body.classList.contains("modal-open")).toBe(true);
                expect(holding).toEqual(["hold", "let go", "hold", "hidden handled"]);
            },
        );

        it("lets other modals show after a hide that was prevented", async () => {
            modals.show("info");
            await vi.runAllTimersAsync();
            document
                .getElementById("info")
                .addEventListener("hide.bs.modal", (event) => event.preventDefault(), { once: true });
            modals.hide("info");
            modals.show("help");
            await vi.runAllTimersAsync();
            expect(document.getElementById("help").classList.contains("show")).toBe(true);
        });
    });

    it("notes the opening of a dialog that declares its feature, and of no other", () => {
        const sent = sentEvents();
        raise("info");
        raise("help");
        const noted = new Set(sent("feature_used").map(({ feature, action }) => `${feature} ${action}`));
        expect(noted).toEqual(new Set(["help open"]));
    });

    describe("showError", () => {
        it("fills in what was being done and what went wrong", () => {
            modals.showError("saving state", "disc full");
            const dialog = document.getElementById("error-dialog");
            expect(dialog.querySelector(".context").textContent).toBe("saving state");
            expect(dialog.querySelector(".error").textContent).toBe("disc full");
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

        it("asks the last question raised while the dialog's backdrop is still fading, answering the others no", async () => {
            const first = modals.confirm("Restart now?", "Restart", "Later");
            await vi.runAllTimersAsync();
            modals.hide("are-you-sure");
            await vi.advanceTimersToNextTimerAsync();
            const second = modals.confirm("Switch machine?", "Switch", "Stay");
            const third = modals.confirm("Save anyway?", "Save anyway", "Cancel");
            await vi.runAllTimersAsync();
            await expect(first).resolves.toBe(false);
            await expect(second).resolves.toBe(false);
            expect(dialog().querySelector(".context").textContent).toBe("Save anyway?");
            dialog().querySelector(".ays-yes").click();
            await vi.runAllTimersAsync();
            await expect(third).resolves.toBe(true);
        });

        it("answers no at once to a question asked while another is up, leaving that one on screen", async () => {
            const first = modals.confirm("Restart now?", "Restart", "Later");
            await vi.runAllTimersAsync();
            await expect(modals.confirm("Switch machine?", "Switch", "Stay")).resolves.toBe(false);
            expect(dialog().querySelector(".context").textContent).toBe("Restart now?");
            dialog().querySelector(".ays-yes").click();
            await vi.runAllTimersAsync();
            await expect(first).resolves.toBe(true);
        });
    });

    describe("show and hide by id", () => {
        it("ignores an id that is not on the page", () => {
            expect(() => modals.show("no-such-dialog")).not.toThrow();
            expect(() => modals.hide("no-such-dialog")).not.toThrow();
        });
    });
});
