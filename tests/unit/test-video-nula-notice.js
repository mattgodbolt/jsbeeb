// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { answerMissingVideoNula, offerVideoNula } from "../../src/web/video-nula-notice.js";
import { sentEvents, teardownDom, toasts } from "./helpers.js";

describe("offerVideoNula", () => {
    afterEach(teardownDom);

    const fitButton = () => document.querySelector(".toast .toast-action");

    it("says the VideoNuLA is missing and offers to fit one", () => {
        const fit = vi.fn();
        offerVideoNula({ inSession: false, fit });
        expect(toasts()).toEqual([
            expect.stringContaining("This program tried to use a VideoNuLA, which isn't fitted."),
        ]);
        expect(fitButton().hidden).toBe(false);
        expect(fitButton().textContent).toBe("Fit one and restart");
        fitButton().click();
        expect(fit).toHaveBeenCalledTimes(1);
    });

    it("leaves the keyboard with the machine", () => {
        const machine = document.createElement("canvas");
        machine.tabIndex = 0;
        document.body.append(machine);
        machine.focus();
        offerVideoNula({ inSession: false, fit: vi.fn() });
        expect(document.activeElement).toBe(machine);
    });

    it("offers nothing in a shared session, which fitting one would end", () => {
        const fit = vi.fn();
        offerVideoNula({ inSession: true, fit });
        expect(toasts()[0]).toContain("One can be fitted once the shared session is over.");
        expect(fitButton().hidden).toBe(true);
    });

    describe("the page's answer", () => {
        const answer = (inSession) => {
            const settings = { set: vi.fn() };
            const restart = vi.fn();
            vi.useFakeTimers();
            answerMissingVideoNula({ inSession: () => inSession, settings, restart })();
            return { settings, restart };
        };

        it("waits for the emulator to let go, then fits one through the settings and restarts", () => {
            const { settings, restart } = answer(false);
            expect(toasts()).toEqual([]);
            vi.runOnlyPendingTimers();
            fitButton().click();
            expect(settings.set).toHaveBeenCalledWith({ hasVideoNula: true });
            expect(restart).toHaveBeenCalledTimes(1);
        });

        it("fits nothing if a shared session started while the offer was up", () => {
            let inSession = false;
            const settings = { set: vi.fn() };
            const restart = vi.fn();
            vi.useFakeTimers();
            answerMissingVideoNula({ inSession: () => inSession, settings, restart })();
            vi.runOnlyPendingTimers();
            inSession = true;
            fitButton().click();
            expect(settings.set).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(toasts().at(-1)).toContain("One can be fitted once the shared session is over.");
        });

        it("offers nothing to fit while a shared session runs", () => {
            answer(true);
            vi.runOnlyPendingTimers();
            expect(toasts()[0]).toContain("once the shared session is over");
            expect(fitButton().hidden).toBe(true);
        });
    });

    it("notes the VideoNuLA as missing, even for a user who asked not to be told", () => {
        const sent = sentEvents();
        window.localStorage.setItem("quietVideoNulaMissing", "yes");
        offerVideoNula({ inSession: false, fit: vi.fn() });
        expect(toasts()).toEqual([]);
        expect(sent("feature_used")).toEqual([{ feature: "videonula", action: "missing" }]);
    });
});
