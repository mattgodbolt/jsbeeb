// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleDriveLoader } from "../../src/web/google-drive.js";
import { DiscLayout } from "../../src/disc.js";
import { ssdImage, teardownDom } from "./helpers.js";

describe("GoogleDriveLoader", () => {
    beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));

    afterEach(teardownDom);

    describe("creating a disc", () => {
        const fortyTrackSectors = 400;
        const makeSignedIn = () => {
            const loader = new GoogleDriveLoader();
            loader.parentFolderId = "folder";
            loader.gapi = {
                client: {
                    request: vi
                        .fn()
                        .mockResolvedValue({
                            result: { id: "xyz", name: "fresh.ssd", capabilities: { canEdit: true } },
                        }),
                },
            };
            return loader;
        };

        it("lays the new disc out as the drive it is for wants", async () => {
            const loader = makeSignedIn();
            const detected = await loader.create("fresh.ssd", ssdImage(fortyTrackSectors), DiscLayout.auto);
            expect(detected.fileId).toBe("xyz");
            expect(detected.disc.is40Track).toBe(true);
            const contiguous = await loader.create("fresh.ssd", ssdImage(fortyTrackSectors), DiscLayout.contiguous);
            expect(contiguous.disc.is40Track).toBe(false);
        });
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
