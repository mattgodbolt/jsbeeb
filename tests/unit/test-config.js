import { describe, it, expect } from "vitest";
import { fittedRoms } from "../../src/config.js";
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
