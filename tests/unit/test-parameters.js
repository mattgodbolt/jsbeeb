import { describe, expect, it } from "vitest";

import { Parameters, SlidParams, StoredParams, tubeCpuSpeedLabel, UrlParamTypes } from "../../src/web/parameters.js";
import { ConfigForm, settingFields } from "../../src/web/config-form.js";
import { ParamTypes } from "../../src/url-params.js";
import { persistenceSettings } from "../../src/web/canvas.js";
import { findModel } from "../../src/models.js";

describe("Parameters", () => {
    it("types every parameter", () => {
        for (const [name, type] of Object.entries(UrlParamTypes)) {
            expect(Object.values(ParamTypes), name).toContain(type);
        }
    });

    it("declares each display's afterglow a remembered slider setting", () => {
        for (const { setting } of persistenceSettings()) {
            expect(UrlParamTypes[setting], setting).toBe(ParamTypes.FLOAT);
            expect(StoredParams, setting).toContain(setting);
            expect(SlidParams, setting).toContain(setting);
        }
    });

    it("places every Settings field it declares in the form, once", () => {
        const declared = Object.keys(Parameters).filter((name) => Parameters[name].field);
        const placed = settingFields(ConfigForm).map(({ setting }) => setting);
        expect([...placed].sort()).toEqual([...declared].sort());
    });
});

describe("tubeCpuSpeedLabel", () => {
    const bbcB = findModel("B-DFS1.2");
    const master = findModel("Master");

    it("shows each machine's own second processor at 1x", () => {
        expect(tubeCpuSpeedLabel(1, bbcB)).toBe("1x (3MHz)");
        expect(tubeCpuSpeedLabel(1, master)).toBe("1x (4MHz)");
    });

    it("shows a fractional overclock", () => {
        expect(tubeCpuSpeedLabel(1.6, bbcB)).toBe("1.6x (4.8MHz)");
    });

    it("keeps a repeating multiplier from a URL readable", () => {
        expect(tubeCpuSpeedLabel(4 / 3, bbcB)).toBe("1.33x (4MHz)");
    });
});
