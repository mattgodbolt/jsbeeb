// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleDriveLoader } from "../../src/google-drive.js";

describe("GoogleDriveLoader", () => {
    beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("gives up when the Google script cannot be fetched", async () => {
        const loader = new GoogleDriveLoader();

        const initialising = loader.initialise();
        const script = document.querySelector("script");
        script.dispatchEvent(new Event("error"));

        expect(script.src).toContain("apis.google.com");
        await expect(initialising).rejects.toThrow(/apis\.google\.com/);
    });

    it("shares one initialisation between concurrent callers", async () => {
        const loader = new GoogleDriveLoader();

        const first = loader.initialise();
        const second = loader.initialise();
        expect(second).toBe(first);
        expect(document.querySelectorAll("script")).toHaveLength(1);

        document.querySelector("script").dispatchEvent(new Event("error"));
        await expect(first).rejects.toThrow();
        await expect(second).rejects.toThrow();
    });

    it("tries again after a failed initialisation", async () => {
        const loader = new GoogleDriveLoader();

        const failed = loader.initialise();
        document.querySelector("script").dispatchEvent(new Event("error"));
        await expect(failed).rejects.toThrow();

        const retried = loader.initialise();
        expect(retried).not.toBe(failed);
        expect(document.querySelectorAll("script")).toHaveLength(2);
        document.querySelectorAll("script")[1].dispatchEvent(new Event("error"));
        await expect(retried).rejects.toThrow();
    });
});
