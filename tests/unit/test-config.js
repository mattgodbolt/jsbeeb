import { describe, it, expect } from "vitest";
import { fittedRoms, needsRestart, restartPending } from "../../src/config.js";
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

describe("needsRestart", () => {
    it("says no when nothing changed", () => {
        expect(needsRestart({})).toBe(false);
    });

    it("says no for settings the running machine can follow", () => {
        expect(needsRestart({ keyLayout: "natural", displayMode: "pal", speechOutput: true })).toBe(false);
    });

    it("says yes for the model and the fittings", () => {
        expect(needsRestart({ model: "Master" })).toBe(true);
        expect(needsRestart({ coProcessor: true })).toBe(true);
        expect(needsRestart({ hasEconet: true })).toBe(true);
        expect(needsRestart({ hasMusic5000: true })).toBe(true);
        expect(needsRestart({ hasTeletextAdaptor: true })).toBe(true);
    });

    it("says yes when turning a fitting off, not just on", () => {
        expect(needsRestart({ coProcessor: false })).toBe(true);
    });

    it("says yes when a live setting changed alongside one that needs a restart", () => {
        expect(needsRestart({ speechOutput: true, coProcessor: true })).toBe(true);
    });
});

describe("restartPending", () => {
    const running = {
        model: "B-DFS1.2",
        coProcessor: false,
        hasEconet: false,
        hasMusic5000: false,
        hasTeletextAdaptor: false,
    };

    it("is not pending when the settings match the running machine", () => {
        expect(restartPending({ ...running }, running)).toBe(false);
    });

    it("is pending when a fitting was added", () => {
        expect(restartPending({ ...running, coProcessor: true }, running)).toBe(true);
    });

    it("stops being pending once the setting is put back", () => {
        const changed = { ...running, hasMusic5000: true };
        expect(restartPending(changed, running)).toBe(true);
        expect(restartPending({ ...changed, hasMusic5000: false }, running)).toBe(false);
    });

    it("ignores settings the running machine can follow", () => {
        expect(restartPending({ ...running, keyLayout: "natural" }, running)).toBe(false);
    });
});
