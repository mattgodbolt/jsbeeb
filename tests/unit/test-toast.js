// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as bootstrap from "bootstrap";

import { toast } from "../../src/web/toast.js";
import { teardownDom } from "./helpers.js";

describe("toast", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(teardownDom);

    const toasts = () => [...document.querySelectorAll(".toast")];

    it("leaves no timer running once it has been and gone", () => {
        toast("A disc was swapped.");
        vi.runAllTimers();

        expect(vi.getTimerCount()).toBe(0);
        expect(toasts()).toHaveLength(0);
    });

    it("lets go of the toast it finished with", () => {
        const element = toast("A disc was swapped.");
        vi.runAllTimers();

        expect(bootstrap.Toast.getInstance(element)).toBeNull();
    });

    it("says what it was given", () => {
        toast("A disc was swapped.", { title: "Disc drive" });

        expect(toasts()).toHaveLength(1);
        expect(toasts()[0].querySelector(".message").textContent).toBe("A disc was swapped.");
        expect(toasts()[0].querySelector(".toast-header strong").textContent).toBe("Disc drive");
    });

    it("keeps its head down when there is nothing to head it with", () => {
        toast("A disc was swapped.");

        expect(toasts()[0].querySelector(".toast-header").hidden).toBe(true);
    });

    it("stacks up in one container", () => {
        toast("One.");
        toast("Two.");

        expect(document.querySelectorAll(".toast-container")).toHaveLength(1);
        expect(toasts()).toHaveLength(2);
    });

    it("treats a disc's name as text, whatever it holds", () => {
        toast(`Loaded <img src=x onerror="alert(1)">.`);

        expect(toasts()[0].querySelectorAll("img")).toHaveLength(0);
        expect(toasts()[0].querySelector(".message").textContent).toContain("onerror");
    });

    it("offers to stop only when there is somewhere to remember the answer", () => {
        toast("Told once.", { quietKey: "quietTest" });
        toast("Told again.");

        expect(toasts()[0].querySelector(".form-check").hidden).toBe(false);
        expect(toasts()[1].querySelector(".form-check").hidden).toBe(true);
    });

    it("remembers being told to stop, and stops", () => {
        toast("Told once.", { quietKey: "quietTest" });
        const quiet = toasts()[0].querySelector(".form-check input");
        quiet.checked = true;
        quiet.dispatchEvent(new window.Event("change"));

        expect(window.localStorage.quietTest).toBe("yes");
        expect(toast("Told again.", { quietKey: "quietTest" })).toBe(undefined);
        expect(toasts()).toHaveLength(1);
    });

    it("says its piece when it cannot remember whether it was told not to", () => {
        const storage = window.localStorage;
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            get() {
                throw new Error("no storage for you");
            },
        });
        try {
            expect(() => toast("Told anyway.", { quietKey: "quietTest" })).not.toThrow();
            expect(toasts()).toHaveLength(1);
        } finally {
            Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
        }
    });

    it("says it again once it is allowed to", () => {
        window.localStorage.quietTest = "yes";
        toast("Suppressed.", { quietKey: "quietTest" });
        expect(toasts()).toHaveLength(0);

        window.localStorage.removeItem("quietTest");
        toast("Allowed.", { quietKey: "quietTest" });

        expect(toasts()).toHaveLength(1);
    });
});
