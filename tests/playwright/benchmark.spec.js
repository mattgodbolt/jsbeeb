// The ?benchmark= page mode, driven as a script would drive it.

import { expect, test } from "./fixtures.js";

// Three passes of fifteen emulated seconds each, unthrottled, under the software renderer CI uses.
const BenchmarkTimeoutMs = 120000;

test("runs a workload and publishes its result for a script to wait on", async ({ beeb, page }) => {
    test.setTimeout(BenchmarkTimeoutMs);
    await beeb.open("?benchmark=elite");
    await page.waitForFunction(() => window.jsbeebBenchmark);
    const record = await page.evaluate(() =>
        window.jsbeebBenchmark.done.then(({ status, error, line, result }) => ({
            status,
            error,
            line,
            passes: Object.keys(result.passes),
            split: Object.keys(result.split),
            mhz: result.mhz,
        })),
    );
    expect(record).toMatchObject({
        status: "done",
        passes: ["full", "video", "cpu"],
        split: ["cpu", "video", "copy", "present"],
    });
    expect(record.mhz).toBeGreaterThan(0);
    expect(record.line).toMatch(
        /^jsbeeb benchmark elite \(B-DFS1\.2\): [\d.]+ MHz\. .*crossOriginIsolated (true|false)/,
    );
    await expect(page.locator("#benchmark .benchmark-line")).toHaveValue(record.line);
});
