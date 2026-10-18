// The ?benchmark= page mode, driven as a script would drive it.

import { expect, test } from "./fixtures.js";

// Three passes of fifteen emulated seconds each, unthrottled, under the software renderer CI uses.
const BenchmarkTimeoutMs = 120000;

const benchmarkRecord = async (page) => {
    await page.waitForFunction(() => window.jsbeebBenchmark);
    return page.evaluate(() =>
        window.jsbeebBenchmark.done.then(({ status, error, line, result }) => ({ status, error, line, result })),
    );
};

const analyticsSent = (page) =>
    page.evaluate(() => window.dataLayer.filter((entry) => entry[0] === "config" || entry[0] === "event"));

test("runs a workload, publishes its result for a script, then runs the machine", async ({ beeb, page }) => {
    test.setTimeout(BenchmarkTimeoutMs);
    await beeb.open("?benchmark=elite");
    await expect(page.locator("#benchmark .benchmark-status")).toBeVisible();
    await expect(page.locator("#benchmark .benchmark-close")).toHaveCount(2);
    for (const close of await page.locator("#benchmark .benchmark-close").all()) await expect(close).toBeHidden();
    const { status, line, result } = await benchmarkRecord(page);
    expect(status).toBe("done");
    expect(Object.keys(result.passes)).toEqual(["full", "video", "cpu"]);
    expect(Object.keys(result.split)).toEqual(["cpu", "video", "copy", "present"]);
    expect(result.mhz).toBeGreaterThan(0);
    expect(line).toMatch(/^jsbeeb benchmark elite \(B-DFS1\.2\): [\d.]+ MHz\. .*crossOriginIsolated (true|false)/);
    await expect(page.locator("#benchmark .benchmark-line")).toHaveValue(line);
    expect(await analyticsSent(page)).toEqual([]);

    await beeb.expectDrive0("elite.ssd");
    const held = await beeb.expectHeld();
    await page.locator("#benchmark .modal-footer .benchmark-close").click();
    await beeb.expectRunningPast(held);
});

test("a workload for another model fails, saying which model it needs", async ({ beeb, page }) => {
    await beeb.open("?benchmark=master-shadow");
    const { status, error } = await benchmarkRecord(page);
    expect({ status, error }).toEqual({
        status: "failed",
        error: "The master-shadow workload runs on the Master: add &model=Master to the URL",
    });
    await expect(page.locator("#benchmark .benchmark-status")).toContainText("add &model=Master");
});
