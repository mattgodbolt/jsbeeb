// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Config, fittedRoms } from "../../src/config.js";
import { findModel } from "../../src/models.js";

describe("fittedRoms", () => {
    const master = findModel("Master");
    const beeb = findModel("B-DFS1.2");
    const none = { model: beeb, hasEconet: false, hasMusic5000: false, hasTeletextAdaptor: false };

    it("fits nothing when nothing is enabled", () => {
        expect(fittedRoms(none)).toEqual([]);
    });

    it("fits the Music 5000 and teletext ROMs", () => {
        expect(fittedRoms({ ...none, hasMusic5000: true })).toEqual(["ample.rom"]);
        expect(fittedRoms({ ...none, hasTeletextAdaptor: true })).toEqual(["ats-3.0.rom"]);
    });

    it("fits ANFS only on a Master", () => {
        expect(fittedRoms({ ...none, model: master, hasEconet: true })).toEqual(["master/anfs-4.25.rom"]);
        expect(fittedRoms({ ...none, hasEconet: true })).toEqual([]);
    });

    it("orders the ROMs so bank allocation is predictable", () => {
        const all = { model: master, hasEconet: true, hasMusic5000: true, hasTeletextAdaptor: true };

        expect(fittedRoms(all)).toEqual(["master/anfs-4.25.rom", "ample.rom", "ats-3.0.rom"]);
    });

    it("gives the same answer however many times it is asked", () => {
        const all = { model: master, hasEconet: true, hasMusic5000: true, hasTeletextAdaptor: true };

        expect(fittedRoms(all)).toEqual(fittedRoms(all));
    });
});

// The tests drive the shipped markup rather than a hand-written fixture, so they notice if the
// dialog's ids or classes drift away from what Config expects.
const indexHtml = readFileSync("index.html", "utf8");

/** Drives the real settings dialog markup the way the browser and bootstrap would. */
class Dialog {
    constructor() {
        this.onClose = vi.fn();
        this.onRestartRequired = vi.fn();
        this.settingsChanged = vi.fn();
        this.config = new Config(
            () => {},
            (changed) => this.onClose(changed),
            () => this.onRestartRequired(),
        );
        this.config.addEventListener("settings-changed", (e) => this.settingsChanged(e.detail));
        // Mirrors main.js applying the startup settings before the dialog is ever shown.
        this.config.setModel("B-DFS1.2");
        this.config.set65c02(false);
        this.config.setTubeCpuMultiplier(2);
        this.config.setEconet(false);
        this.config.setMusic5000(false);
        this.config.setTeletext(false);
    }

    open() {
        document.getElementById("configuration").dispatchEvent(new Event("show.bs.modal"));
    }

    close() {
        document.getElementById("configuration").dispatchEvent(new Event("hide.bs.modal"));
    }

    tick(id) {
        document.getElementById(id).click();
    }

    chooseModel(name) {
        document.querySelector(`.model-menu a[data-target="${name}"]`).click();
    }

    checkbox(id) {
        return document.getElementById(id).checked;
    }

    get pendingShown() {
        return !document.getElementById("restart-pending").classList.contains("d-none");
    }
}

describe("Config settings dialog", () => {
    beforeEach(() => {
        document.body.innerHTML = indexHtml;
    });

    describe("settings that need a restart", () => {
        it("saves a co-processor change and asks about restarting", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.tick("65c02");
            dialog.close();

            expect(dialog.onClose).toHaveBeenCalledWith({ coProcessor: true });
            expect(dialog.settingsChanged).toHaveBeenCalledWith({ coProcessor: true });
            expect(dialog.onRestartRequired).toHaveBeenCalledTimes(1);
            expect(dialog.config.coProcessor).toBe(true);
            expect(dialog.checkbox("65c02")).toBe(true);
        });

        it("saves a model change", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.chooseModel("Master");
            dialog.close();

            expect(dialog.settingsChanged).toHaveBeenCalledWith({ model: "Master" });
            expect(dialog.config.model).toBe(findModel("Master"));
            expect(dialog.onRestartRequired).toHaveBeenCalledTimes(1);
        });

        it("shows the saved values, marked pending, when the dialog is opened again", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.tick("65c02");
            dialog.tick("hasEconet");
            dialog.close();

            dialog.open();

            expect(dialog.checkbox("65c02")).toBe(true);
            expect(dialog.checkbox("hasEconet")).toBe(true);
            expect(dialog.pendingShown).toBe(true);
        });

        it("does not re-save or re-ask on a later visit that changes nothing", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.tick("hasMusic5000");
            dialog.close();

            dialog.open();
            dialog.close();

            expect(dialog.settingsChanged).toHaveBeenCalledTimes(1);
            expect(dialog.onRestartRequired).toHaveBeenCalledTimes(1);
        });

        it("stops marking a setting pending once it is put back", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.tick("hasMusic5000");
            dialog.close();

            dialog.open();
            dialog.tick("hasMusic5000");
            dialog.close();

            dialog.open();

            expect(dialog.checkbox("hasMusic5000")).toBe(false);
            expect(dialog.pendingShown).toBe(false);
        });

        it("asks nothing when only live settings changed", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.tick("speechOutput");
            dialog.close();

            expect(dialog.onRestartRequired).not.toHaveBeenCalled();
            expect(dialog.settingsChanged).toHaveBeenCalledWith({ speechOutput: true });
        });
    });

    describe("settings that apply live", () => {
        it("saves them alongside a change that needs a restart", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.tick("speechOutput");
            dialog.tick("65c02");
            dialog.close();

            expect(dialog.onClose).toHaveBeenCalledWith({ speechOutput: true, coProcessor: true });
            expect(dialog.settingsChanged).toHaveBeenCalledTimes(1);
            expect(dialog.settingsChanged).toHaveBeenCalledWith({ speechOutput: true, coProcessor: true });
        });

        it("does not mark the dialog pending on their own", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.tick("mouseJoystickEnabled");
            dialog.close();

            dialog.open();

            expect(dialog.pendingShown).toBe(false);
        });

        it("says nothing changed when nothing did", () => {
            const dialog = new Dialog();
            dialog.open();
            dialog.close();

            expect(dialog.settingsChanged).not.toHaveBeenCalled();
            expect(dialog.onRestartRequired).not.toHaveBeenCalled();
        });
    });
});
