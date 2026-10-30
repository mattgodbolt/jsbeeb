import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, HttpError, isTransient } from "../../../tools/mirror-common.js";

describe("fetchWithRetry", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const respond = (status) => ({ ok: status >= 200 && status < 300, status });

    it("does not retry a 404 — a file the index promised is a fault to report, not a blip", async () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(404));

        await expect(fetchWithRetry("https://example.com/gone.zip", 0, null)).rejects.toThrow("HTTP 404");
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("retries a 5xx and succeeds once the server recovers", async () => {
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(respond(503))
            .mockResolvedValueOnce(respond(500))
            .mockResolvedValue(respond(200));

        await expect(fetchWithRetry("https://example.com/flaky.zip", 0, null)).resolves.toMatchObject({ status: 200 });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("retries a dropped connection", async () => {
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValue(respond(200));

        await expect(fetchWithRetry("https://example.com/slow.zip", 0, null)).resolves.toMatchObject({ status: 200 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("gives up rather than hammering a server that stays broken", async () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(503));

        await expect(fetchWithRetry("https://example.com/down.zip", 0, null)).rejects.toThrow("HTTP 503");
        expect(fetch).toHaveBeenCalledTimes(4); // the first try plus MaxRetries
    });
});

describe("isTransient", () => {
    it.each([
        [503, true],
        [500, true],
        [429, true],
        [404, false],
        [403, false],
    ])("treats HTTP %i as transient=%s", (status, expected) => {
        expect(isTransient(new HttpError(status, "https://example.com/x.zip"))).toBe(expected);
    });

    it("treats a non-HTTP failure as transient", () => {
        expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    });
});
