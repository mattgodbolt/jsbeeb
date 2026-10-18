import { describe, expect, it } from "vitest";

import { differingParts } from "../../../tools/same-answer.js";

describe("differingParts", () => {
    const recorded = { framebuffer: "aa", registers: "bb", cycles: "cc" };

    it("is empty when every part matches", () => {
        expect(differingParts(recorded, { ...recorded })).toEqual([]);
    });

    it("names each part whose hash changed", () => {
        expect(differingParts(recorded, { ...recorded, registers: "b0", cycles: "c0" })).toEqual([
            "registers",
            "cycles",
        ]);
    });

    it("names a part recorded on only one side", () => {
        expect(differingParts(recorded, { framebuffer: "aa", registers: "bb", sound: "dd" })).toEqual([
            "cycles",
            "sound",
        ]);
    });
});
