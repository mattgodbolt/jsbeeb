// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SnapshotUI, isSnapshotFile, snapshotMedia } from "../../src/web/snapshot-ui.js";
import { DiscLayout } from "../../src/disc.js";

const Markup = `<a id="save-state"></a><input type="file" id="load-state" />`;

/** A catalogued single-density image, the smallest thing discFor accepts. */
function ssdImage(sectors = 800) {
    const data = new Uint8Array(80 * 10 * 256);
    data[0x106] = (sectors >>> 8) & 3;
    data[0x107] = sectors & 0xff;
    return data;
}

describe("snapshot media manifest", () => {
    const urlDisc = { originalImageCrc32: 0x1234, is40Track: false, originalImageData: null };
    const localDisc = {
        originalImageCrc32: 0x5678,
        is40Track: true,
        originalImageData: new Uint8Array([1, 2]),
        name: "mine.ssd",
    };

    it("is nothing when no drive holds anything worth recording", () => {
        expect(snapshotMedia([{ disc: null }, { disc: null }], {})).toBeUndefined();
    });

    it("names a URL-sourced disc and carries its CRC and layout", () => {
        const manifest = snapshotMedia([{ disc: urlDisc }, { disc: null }], { disc1: "sth:ELITE.zip" });
        expect(manifest).toEqual({
            disc1: "sth:ELITE.zip",
            disc1Crc32: 0x1234,
            disc1Layout: DiscLayout.contiguous,
        });
    });

    it("takes the bare disc parameter when disc1 is not set", () => {
        const manifest = snapshotMedia([{ disc: null }, { disc: null }], { disc: "elite.ssd" });
        expect(manifest.disc1).toBe("elite.ssd");
    });

    it("embeds the bytes of a local disc, with its name and 40 track layout", () => {
        const manifest = snapshotMedia([{ disc: localDisc }, { disc: null }], {});
        expect(manifest.disc1).toBeUndefined();
        expect(manifest.disc1ImageData).toBe(localDisc.originalImageData);
        expect(manifest.disc1Name).toBe("mine.ssd");
        expect(manifest.disc1Layout).toBe(DiscLayout.expanded40);
    });

    it("records drive 1 under its own keys", () => {
        const manifest = snapshotMedia([{ disc: null }, { disc: urlDisc }], { disc2: "b.ssd" });
        expect(manifest.disc2).toBe("b.ssd");
        expect(manifest.disc2Crc32).toBe(0x1234);
    });
});

describe("isSnapshotFile", () => {
    it("knows the state file extensions", () => {
        expect(isSnapshotFile("state.snp")).toBe(true);
        expect(isSnapshotFile("state.json")).toBe(true);
        expect(isSnapshotFile("state.json.gz")).toBe(true);
        expect(isSnapshotFile("elite.ssd")).toBe(false);
    });

    it("treats a uef that is not a BeebEm state as a tape", () => {
        expect(isSnapshotFile("tape.uef", new Uint8Array([1, 2, 3]).buffer)).toBe(false);
    });
});

describe("SnapshotUI", () => {
    let deps;

    beforeEach(() => {
        document.body.innerHTML = Markup;
        deps = {
            processor: { fdc: { drives: [{ disc: null }, { disc: null }] }, hasTube: false, execute: vi.fn() },
            model: { name: "B-DFS1.2" },
            video: { paint: vi.fn() },
            media: { loadDiscImage: vi.fn(), setDisc1Image: vi.fn(), setDisc2Image: vi.fn() },
            drives: { putDiscIn: vi.fn() },
            urlState: { params: {}, urlWith: vi.fn() },
            modals: { showError: vi.fn() },
            loop: { isRunning: () => true, stop: vi.fn(), go: vi.fn() },
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
        window.localStorage.clear();
        window.sessionStorage.clear();
    });

    const make = () => new SnapshotUI(deps);
    const toasts = () =>
        [...document.querySelectorAll(".toast")].map((el) => el.textContent.replace(/\s+/g, " ").trim());

    describe("loading a state", () => {
        it("stops the emulator, reports a file it cannot read, and runs on", async () => {
            await make().loadStateFromFile(null, new Uint8Array([0x00, 0x01, 0x02]).buffer);
            expect(deps.loop.stop).toHaveBeenCalledWith(false);
            expect(deps.modals.showError).toHaveBeenCalledWith("loading state", expect.anything());
            expect(deps.loop.go).toHaveBeenCalledTimes(1);
        });

        it("leaves a stopped emulator stopped afterwards", async () => {
            deps.loop.isRunning = () => false;
            await make().loadStateFromFile(null, new Uint8Array([0]).buffer);
            expect(deps.loop.stop).not.toHaveBeenCalled();
            expect(deps.loop.go).not.toHaveBeenCalled();
        });
    });

    describe("reloading a snapshot's media", () => {
        it("does nothing for a snapshot with none", async () => {
            await make().reloadSnapshotMedia(undefined);
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        });

        it("reloads a URL-sourced disc from its source and names it in the URL", async () => {
            const loaded = { name: "ELITE.ssd", originalImageCrc32: 0x1234 };
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await make().reloadSnapshotMedia({ disc1: "sth:ELITE.zip", disc1Crc32: 0x1234 });
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("sth:ELITE.zip", DiscLayout.contiguous);
            expect(deps.drives.putDiscIn).toHaveBeenCalledWith(0, loaded);
            expect(deps.media.setDisc1Image).toHaveBeenCalledWith("sth:ELITE.zip");
            expect(toasts()).toEqual([]);
        });

        it("warns when the source has changed under the state", async () => {
            deps.media.loadDiscImage.mockResolvedValue({ name: "ELITE.ssd", originalImageCrc32: 0x9999 });
            await make().reloadSnapshotMedia({ disc1: "sth:ELITE.zip", disc1Crc32: 0x1234 });
            expect(toasts()).toEqual([expect.stringContaining("ELITE.ssd has changed since this state was saved")]);
            expect(deps.drives.putDiscIn).toHaveBeenCalled();
        });

        it("rebuilds an embedded local disc and keeps it out of the URL", async () => {
            const imageData = ssdImage();
            await make().reloadSnapshotMedia({
                disc1ImageData: imageData,
                disc1Name: "mine.ssd",
                disc1Layout: DiscLayout.contiguous,
            });
            const [driveIndex, loadedDisc] = deps.drives.putDiscIn.mock.calls[0];
            expect(driveIndex).toBe(0);
            expect(loadedDisc.name).toBe("mine.ssd");
            expect(loadedDisc.originalImageData).toBeTruthy();
            expect(deps.media.setDisc1Image).not.toHaveBeenCalled();
        });

        it("rebuilds image data that was serialised as a plain object", async () => {
            const imageData = ssdImage();
            await make().reloadSnapshotMedia({
                disc1ImageData: Object.fromEntries(imageData.entries()),
                disc1Name: "mine.ssd",
            });
            expect(deps.drives.putDiscIn).toHaveBeenCalled();
        });

        it("restores drive 1 alongside drive 0", async () => {
            const loaded = { name: "B.ssd" };
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await make().reloadSnapshotMedia({ disc2: "b.ssd" });
            expect(deps.drives.putDiscIn).toHaveBeenCalledWith(1, loaded);
            expect(deps.media.setDisc2Image).toHaveBeenCalledWith("b.ssd");
        });
    });

    describe("the pending state", () => {
        it("is quiet when there is nothing pending", async () => {
            await make().restorePendingState();
            expect(deps.modals.showError).not.toHaveBeenCalled();
            expect(deps.processor.execute).not.toHaveBeenCalled();
        });

        it("consumes a stashed state even when it cannot be restored", async () => {
            sessionStorage.setItem("jsbeeb-pending-state", "not json at all");
            await make().restorePendingState();
            expect(deps.modals.showError).toHaveBeenCalledWith("restoring saved state", expect.anything());
            expect(sessionStorage.getItem("jsbeeb-pending-state")).toBeNull();
        });
    });
});
