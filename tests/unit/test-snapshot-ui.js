// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SnapshotUI, isSnapshotFile, snapshotMedia } from "../../src/web/snapshot-ui.js";
import { DiscLayout } from "../../src/disc.js";
import { domFromIndexHtml, ssdImage, teardownDom, toasts } from "./helpers.js";

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

    const defaultBootDisc = { ...urlDisc, name: "elite.ssd" };

    it("names the default built-in disc when the URL names none", () => {
        const manifest = snapshotMedia([{ disc: defaultBootDisc }, { disc: null }], {}, "elite.ssd");
        expect(manifest.disc1).toBe("elite.ssd");
        expect(manifest.disc1Crc32).toBe(0x1234);
    });

    it("prefers the URL's disc over the default boot disc", () => {
        const manifest = snapshotMedia([{ disc: urlDisc }, { disc: null }], { disc1: "sth:OTHER.zip" }, "elite.ssd");
        expect(manifest.disc1).toBe("sth:OTHER.zip");
    });

    it("embeds a local disc rather than naming the default it replaced", () => {
        const manifest = snapshotMedia([{ disc: localDisc }, { disc: null }], {}, "elite.ssd");
        expect(manifest.disc1).toBeUndefined();
        expect(manifest.disc1ImageData).toBe(localDisc.originalImageData);
    });

    it("does not name the default when the drive holds something else", () => {
        const swappedIn = { ...urlDisc, name: "other.ssd" };
        const manifest = snapshotMedia([{ disc: swappedIn }, { disc: null }], {}, "elite.ssd");
        expect(manifest.disc1).toBeUndefined();
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
        domFromIndexHtml("save-state", "load-state");
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

    afterEach(teardownDom);

    const make = () => new SnapshotUI(deps);

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

        const snapshotBuffer = (snapshot) =>
            new TextEncoder().encode(JSON.stringify({ format: "jsbeeb-snapshot", version: 3, state: {}, ...snapshot }))
                .buffer;

        it("stashes a state for another model and navigates to a matching machine", async () => {
            deps.urlState.urlWith.mockReturnValue(`${window.location.href}#stashed`);
            await make().loadStateFromFile(null, snapshotBuffer({ model: "Master", coProcessor: false }));
            expect(deps.urlState.urlWith).toHaveBeenCalledWith({ model: "Master", coProcessor: false });
            expect(window.location.hash).toBe("#stashed");
            expect(JSON.parse(sessionStorage.getItem("jsbeeb-pending-state")).model).toBe("Master");
            expect(deps.video.paint).not.toHaveBeenCalled();
            expect(deps.loop.go).not.toHaveBeenCalled();
            window.location.hash = "";
        });

        it("treats a co-processor mismatch as a machine change too", async () => {
            deps.urlState.urlWith.mockReturnValue(`${window.location.href}#stashed`);
            await make().loadStateFromFile(null, snapshotBuffer({ model: "B-DFS1.2", coProcessor: true }));
            expect(deps.urlState.urlWith).toHaveBeenCalledWith({ model: "B-DFS1.2", coProcessor: true });
            expect(sessionStorage.getItem("jsbeeb-pending-state")).not.toBeNull();
            window.location.hash = "";
        });

        it("restores a matching state in place and repaints", async () => {
            deps.processor.restoreState = vi.fn();
            await make().loadStateFromFile(null, snapshotBuffer({ model: "B-DFS1.2", coProcessor: false }));
            expect(deps.processor.restoreState).toHaveBeenCalledWith({});
            expect(deps.video.paint).toHaveBeenCalledTimes(1);
            expect(deps.modals.showError).not.toHaveBeenCalled();
            expect(sessionStorage.getItem("jsbeeb-pending-state")).toBeNull();
            expect(deps.loop.go).toHaveBeenCalledTimes(1);
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

        it("refuses to restore when the source has changed under the state", async () => {
            deps.media.loadDiscImage.mockResolvedValue({ name: "ELITE.ssd", originalImageCrc32: 0x9999 });
            await expect(make().reloadSnapshotMedia({ disc1: "sth:ELITE.zip", disc1Crc32: 0x1234 })).rejects.toThrow(
                "ELITE.ssd has changed since this state was saved",
            );
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        });

        it("refuses to restore over an empty drive when the state has a CRC but no source", async () => {
            await expect(make().reloadSnapshotMedia({ disc1Crc32: 0x1234 })).rejects.toThrow(
                "does not record where the disc in drive 0 came from",
            );
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        });

        it("refuses to restore over a different disc when the state has a CRC but no source", async () => {
            deps.processor.fdc.drives[0].disc = { name: "other.ssd", originalImageCrc32: 0x9999 };
            await expect(make().reloadSnapshotMedia({ disc1Crc32: 0x1234 })).rejects.toThrow(
                "does not hold a matching disc",
            );
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        });

        it("accepts a sourceless state when the drive already holds the matching disc", async () => {
            deps.processor.fdc.drives[0].disc = { name: "elite.ssd", originalImageCrc32: 0x1234 };
            await make().reloadSnapshotMedia({ disc1Crc32: 0x1234 });
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        });

        it("rejects a sourceless state when the matching disc is laid out differently", async () => {
            deps.processor.fdc.drives[0].disc = { name: "elite.ssd", originalImageCrc32: 0x1234, is40Track: true };
            await expect(
                make().reloadSnapshotMedia({ disc1Crc32: 0x1234, disc1Layout: DiscLayout.contiguous }),
            ).rejects.toThrow("does not hold a matching disc");
        });

        it("round-trips the media of a default-boot session", async () => {
            const bootDisc = { name: "elite.ssd", originalImageCrc32: 0x1234, is40Track: false };
            deps.processor.fdc.drives[0].disc = bootDisc;
            deps.defaultBootDisc = "elite.ssd";
            const ui = make();
            const manifest = snapshotMedia(deps.processor.fdc.drives, deps.urlState.params, deps.defaultBootDisc);
            deps.media.loadDiscImage.mockResolvedValue(bootDisc);
            await ui.reloadSnapshotMedia(manifest);
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("elite.ssd", DiscLayout.contiguous);
            expect(deps.drives.putDiscIn).toHaveBeenCalledWith(0, bootDisc);
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

        it("picks up a stashed state, settles the machine, and forgets the stash", async () => {
            deps.processor.restoreState = vi.fn();
            sessionStorage.setItem(
                "jsbeeb-pending-state",
                JSON.stringify({
                    format: "jsbeeb-snapshot",
                    version: 3,
                    model: "B-DFS1.2",
                    coProcessor: false,
                    state: { stashed: true },
                }),
            );
            await make().restorePendingState();
            expect(deps.processor.restoreState).toHaveBeenCalledWith({ stashed: true });
            expect(deps.processor.execute).toHaveBeenCalledWith(40000);
            expect(deps.modals.showError).not.toHaveBeenCalled();
            expect(sessionStorage.getItem("jsbeeb-pending-state")).toBeNull();
        });

        it("consumes a stashed state even when it cannot be restored", async () => {
            sessionStorage.setItem("jsbeeb-pending-state", "not json at all");
            await make().restorePendingState();
            expect(deps.modals.showError).toHaveBeenCalledWith("restoring saved state", expect.anything());
            expect(sessionStorage.getItem("jsbeeb-pending-state")).toBeNull();
        });
    });
});
