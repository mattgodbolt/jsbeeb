import { describe, it, expect } from "vitest";
import { findModel } from "../../src/models.js";
import { fake6502 } from "../../src/fake6502.js";

describe("Model", () => {
    describe("withTube", () => {
        it("returns a copy, leaving the original untouched", () => {
            const master = findModel("Master");
            const withTube = master.withTube();

            expect(withTube).not.toBe(master);
            expect(withTube.tube.name).toBe("Tube65C02");
            expect(master.tube).toBeUndefined();
        });

        it("preserves the derived getters", () => {
            const master = findModel("Master");
            const withTube = master.withTube();

            expect(withTube.nmos).toBe(master.nmos);
            expect(withTube.opcodesFactory).toBe(master.opcodesFactory);
        });

        it("preserves the rest of the model", () => {
            const master = findModel("Master");
            const withTube = master.withTube();

            expect(withTube.name).toBe(master.name);
            expect(withTube.isMaster).toBe(master.isMaster);
            expect(withTube.isAtom).toBe(master.isAtom);
            expect(withTube.Fdc).toBe(master.Fdc);
            expect(withTube.os).toBe(master.os);
        });

        it("does not disturb a model that already has a tube", () => {
            const withTube = findModel("Master").withTube();

            expect(withTube.withTube().tube).toBe(withTube.tube);
        });
    });
});

describe("fake6502 tube handling", () => {
    it("attaches a tube when asked", () => {
        expect(fake6502(findModel("Master"), { tube: true }).model.tube.name).toBe("Tube65C02");
    });

    it("does not leak the tube into later machines using the same model", () => {
        fake6502(findModel("Master"), { tube: true });

        expect(findModel("Master").tube).toBeUndefined();
        expect(fake6502(findModel("Master"), {}).model.tube).toBeUndefined();
    });

    it("leaves the model's own tube setting alone when no tube is specified", () => {
        const model = findModel("Master").withTube();

        expect(fake6502(model, {}).model.tube.name).toBe("Tube65C02");
    });
});
