import { describe, expect, it } from "vitest";

import { checkHashes, differingParts, Frames } from "../../../tools/same-answer.js";

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

describe("checkHashes", () => {
    const hashes = { one: { memory: "11", cycles: "12" }, two: { memory: "21", cycles: "22" } };
    const recorded = { frames: Frames, workloads: hashes };
    const hashesFrom = (actual) => async (name) => actual[name];

    it("passes every workload whose hashes match", async () => {
        expect(await checkHashes(recorded, ["one", "two"], hashesFrom(hashes))).toEqual({
            lines: ["one: pass", "two: pass"],
            failures: 0,
        });
    });

    it("names the parts that differ for a workload that fails", async () => {
        const actual = { ...hashes, two: { memory: "21", cycles: "2f" } };
        const { lines, failures } = await checkHashes(recorded, ["one", "two"], hashesFrom(actual));
        expect(lines.slice(0, 2)).toEqual(["one: pass", "two: FAIL, cycles differ"]);
        expect(failures).toBe(1);
    });

    it("fails a workload that throws, with its error, and checks the rest", async () => {
        const hashesOf = async (name) => {
            if (name === "one") throw new Error('Workload "one" is not running');
            return hashes[name];
        };
        const { lines, failures } = await checkHashes(recorded, ["one", "two"], hashesOf);
        expect(lines.slice(0, 2)).toEqual(['one: FAIL, Workload "one" is not running', "two: pass"]);
        expect(failures).toBe(1);
    });

    it("fails a workload with no recorded hashes, and one recorded that no longer exists", async () => {
        const { lines, failures } = await checkHashes(recorded, ["two", "three"], hashesFrom(hashes));
        expect(lines.slice(0, 3)).toEqual([
            "two: pass",
            "three: FAIL, no recorded hashes in tests/same-answer-hashes.json",
            "one: FAIL, recorded in tests/same-answer-hashes.json but no longer a workload",
        ]);
        expect(failures).toBe(2);
        expect(lines[3]).toMatch(/^2 failed; .*--record/);
    });

    it("asks for a re-record, not a comparison, when the frame count changed", async () => {
        expect(await checkHashes({ ...recorded, frames: Frames + 1 }, ["one", "two"], hashesFrom({}))).toEqual({
            lines: [
                `tests/same-answer-hashes.json was recorded over ${Frames + 1} frames, not ${Frames}; rerun with --record`,
            ],
            failures: 1,
        });
    });
});
