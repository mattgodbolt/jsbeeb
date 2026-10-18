// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { offerVideoNula } from "../../src/web/video-nula-notice.js";
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
        expect(fitButton().textContent).toBe("Fit one");
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

    it("notes the VideoNuLA as missing, even for a user who asked not to be told", () => {
        const sent = sentEvents();
        window.localStorage.setItem("quietVideoNulaMissing", "yes");
        offerVideoNula({ inSession: false, fit: vi.fn() });
        expect(toasts()).toEqual([]);
        expect(sent("feature_used")).toEqual([{ feature: "videonula", action: "missing" }]);
    });
});
