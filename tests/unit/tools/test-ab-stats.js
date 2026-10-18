import { describe, expect, it } from "vitest";

import {
    comparePairs,
    describeComparison,
    sampleUntilResolved,
    signedRankCdf,
    studentTCdf,
    studentTQuantile,
    summarisePairs,
    verdict,
} from "../../../tools/ab-stats.js";

const pairsWithLogRatios = (logRatios) => logRatios.map((logRatio) => ({ a: 50, b: 50 * Math.exp(logRatio) }));

describe("Student's t", () => {
    it.each([
        [0.975, 1, 12.7062],
        [0.975, 2, 4.3027],
        [0.975, 5, 2.5706],
        [0.975, 30, 2.0423],
        [0.995, 10, 3.1693],
        [0.8, 10, 0.8791],
    ])("puts the %s quantile at %s degrees of freedom where the tables do", (p, df, t) => {
        expect(studentTQuantile(p, df)).toBeCloseTo(t, 3);
    });

    it("is symmetric about zero", () => {
        expect(studentTQuantile(0.025, 7)).toBeCloseTo(-studentTQuantile(0.975, 7), 10);
        expect(studentTCdf(0, 7)).toBeCloseTo(0.5, 10);
    });
});

describe("signedRankCdf", () => {
    it("matches the tables' critical values", () => {
        const cdf = signedRankCdf(10);
        expect(cdf[8]).toBeCloseTo(25 / 1024, 10);
        expect(cdf[9]).toBeGreaterThan(0.025);
        expect(cdf.at(-1)).toBeCloseTo(1, 10);
    });
});

describe("comparePairs", () => {
    const hundredths = (count) => Array.from({ length: count }, (_, index) => (index + 1) / 100);

    it("gives the Hodges-Lehmann estimate and the Wilcoxon interval on the log ratios", () => {
        // For 10 pairs the 95% interval runs from the 9th smallest Walsh average to the 9th largest.
        const { ratio, low, high } = comparePairs(pairsWithLogRatios(hundredths(10)));
        expect(ratio).toBeCloseTo(Math.exp(0.055), 10);
        expect(low).toBeCloseTo(Math.exp(0.03), 10);
        expect(high).toBeCloseTo(Math.exp(0.08), 10);
    });

    it("is not moved far by one pair that other load caught", () => {
        const steady = hundredths(10);
        const caught = [...steady.slice(0, 9), 0.5];
        expect(comparePairs(pairsWithLogRatios(caught)).ratio).toBeLessThan(Math.exp(0.065));
    });

    it("inverts when A and B swap", () => {
        const pairs = pairsWithLogRatios([0.01, 0.04, -0.02, 0.03, 0.02, 0.05, -0.01, 0.0]);
        const swapped = pairs.map(({ a, b }) => ({ a: b, b: a }));
        const forward = comparePairs(pairs);
        const backward = comparePairs(swapped);
        expect(backward.ratio).toBeCloseTo(1 / forward.ratio, 10);
        expect(backward.low).toBeCloseTo(1 / forward.high, 10);
        expect(backward.high).toBeCloseTo(1 / forward.low, 10);
    });

    it("widens with the confidence asked for, and so does the change it can detect", () => {
        const pairs = pairsWithLogRatios([0.01, 0.04, -0.02, 0.03, 0.02, 0.05, -0.01, 0.0, 0.015, 0.025]);
        const at95 = comparePairs(pairs, 0.95);
        const at99 = comparePairs(pairs, 0.99);
        expect(at99.low).toBeLessThan(at95.low);
        expect(at99.high).toBeGreaterThan(at95.high);
        expect(at99.minDetectableChange).toBeGreaterThan(at95.minDetectableChange);
    });

    it("has no interval while there are too few pairs to reach the confidence", () => {
        expect(comparePairs(pairsWithLogRatios([0.1, 0.2, 0.3]))).toMatchObject({
            low: 0,
            high: Infinity,
            minDetectableChange: Infinity,
        });
    });

    it("needs two pairs", () => {
        expect(() => comparePairs(pairsWithLogRatios([0.1]))).toThrow("at least two pairs");
    });
});

describe("verdict", () => {
    const horizon = 0.02;
    it.each([
        [{ low: 1.01, high: 1.2 }, "faster"],
        [{ low: 0.8, high: 0.99 }, "slower"],
        [{ low: 0.99, high: 1.01 }, "same"],
        [{ low: 0.97, high: 1.01 }, "unresolved"],
    ])("calls %o %s", (interval, expected) => {
        expect(verdict(interval, horizon)).toBe(expected);
    });
});

describe("summarisePairs", () => {
    it("reports the 95% interval but decides on the 99% one", () => {
        // For 8 pairs the 99% interval spans every log ratio, so the one below zero holds it over 1.
        const summary = summarisePairs(pairsWithLogRatios([-0.01, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07]), 0.02);
        expect(summary.low).toBeGreaterThan(1);
        expect(summary.decisionLow).toBeLessThan(1);
        expect(summary.verdict).toBe("unresolved");
        expect(summary).toMatchObject({ confidence: 0.95, decisionConfidence: 0.99, pairs: 8 });
    });
});

describe("sampleUntilResolved", () => {
    const sampler = (throughput) => {
        const calls = [];
        const sample = async (side) => {
            calls.push(side);
            return throughput[side](calls.filter((called) => called === side).length);
        };
        return { calls, sample };
    };

    it("alternates which side goes first and stops once a clear change has had its minimum pairs", async () => {
        const { calls, sample } = sampler({ a: () => 50, b: (call) => 60 + (call % 3) });
        const result = await sampleUntilResolved({ sample, minPairs: 8, maxPairs: 30, horizon: 0.02 });
        expect(result.verdict).toBe("faster");
        expect(result.pairs).toBe(8);
        expect(calls.slice(0, 8)).toEqual(["a", "b", "b", "a", "a", "b", "b", "a"]);
        expect(result.samples).toHaveLength(8);
    });

    it("stops at the cap when the samples never settle", async () => {
        const { sample } = sampler({ a: () => 50, b: (call) => (call % 2 ? 40 : 62) });
        const result = await sampleUntilResolved({ sample, minPairs: 2, maxPairs: 9, horizon: 0.02 });
        expect(result.verdict).toBe("unresolved");
        expect(result.pairs).toBe(9);
    });

    it("stops when the sides are the same to within the horizon", async () => {
        const { sample } = sampler({ a: (call) => 50 + (call % 3) * 0.1, b: (call) => 50 + (call % 2) * 0.1 });
        const result = await sampleUntilResolved({ sample, minPairs: 8, maxPairs: 30, horizon: 0.02 });
        expect(result.verdict).toBe("same");
        expect(result.pairs).toBe(8);
    });

    it("holds a clear change until it has its minimum pairs, reporting each pair from the second", async () => {
        const { sample } = sampler({ a: () => 50, b: (call) => 60 + (call % 3) });
        const seen = [];
        const result = await sampleUntilResolved({
            sample,
            minPairs: 12,
            maxPairs: 30,
            horizon: 0.02,
            onPair: ({ pairs }) => seen.push(pairs),
        });
        expect(result).toMatchObject({ verdict: "faster", pairs: 12 });
        expect(seen).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it("has no 99% interval to decide on before eight pairs", () => {
        const sevenPairs = pairsWithLogRatios([0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16]);
        expect(summarisePairs(sevenPairs, 0.02).verdict).toBe("unresolved");
        expect(summarisePairs([...sevenPairs, ...pairsWithLogRatios([0.17])], 0.02).verdict).toBe("faster");
    });

    // The figure DecisionConfidence's comment quotes: A/A runs with 2% noise per sample.
    it("calls about one A/A run in twenty faster or slower", async () => {
        let seed = 1337;
        const uniform = () => {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            return (seed + 0.5) / 2 ** 32;
        };
        const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
        const runs = 500;
        let wrong = 0;
        for (let run = 0; run < runs; run++) {
            const sample = async () => 50 * Math.exp(0.02 * normal());
            const { verdict } = await sampleUntilResolved({ sample, minPairs: 8, maxPairs: 30, horizon: 0.02 });
            if (verdict === "faster" || verdict === "slower") wrong++;
        }
        expect(wrong / runs).toBeGreaterThan(0.02);
        expect(wrong / runs).toBeLessThan(0.08);
    });
});

describe("describeComparison", () => {
    it("says the change, its interval, the verdict and what the run could see in one line", () => {
        const logRatios = [0.13, 0.14, 0.15, 0.12, 0.14, 0.13, 0.135, 0.145, 0.14, 0.13];
        expect(describeComparison("elite", summarisePairs(pairsWithLogRatios(logRatios), 0.02))).toMatch(
            /^elite: B\/A 1\.14\d \(\+14\.\d%\), 95% CI \[1\.1\d\d, 1\.1\d\d\], faster; 10 pairs, min detectable change \d\.\d%; median A 50\.00, B 57\.\d\d$/,
        );
    });

    it("ends with what ran the samples, when given", () => {
        const result = summarisePairs(pairsWithLogRatios([0.13, 0.14, 0.15]), 0.02);
        expect(describeComparison("elite", result, "Node v24.18.1")).toMatch(/; Node v24\.18\.1$/);
    });

    it("says when the pairs are too few to know what change they could detect", () => {
        const result = summarisePairs(pairsWithLogRatios([0.13, 0.14, 0.15]), 0.02);
        expect(describeComparison("elite", result)).toContain("3 pairs, too few to say what change they could detect");
    });
});
