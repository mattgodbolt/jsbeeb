// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SnapshotUI, snapshotMedia } from "../../src/web/snapshot-ui.js";
import { Modals } from "../../src/web/modals.js";
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
    const slotsHolding = (drive0, drive1) => ({
        driveSlots: [
            { index: 0, media: drive0?.disc ?? null, ref: drive0?.ref },
            { index: 1, media: drive1?.disc ?? null, ref: drive1?.ref },
        ],
    });

    it("is nothing when no drive holds anything worth recording", () => {
        expect(snapshotMedia(slotsHolding())).toBeUndefined();
    });

    it("names a disc by its reference and carries its CRC and layout", () => {
        const manifest = snapshotMedia(slotsHolding({ disc: urlDisc, ref: "sth:ELITE.zip" }));
        expect(manifest).toEqual({
            disc1: "sth:ELITE.zip",
            disc1Crc32: 0x1234,
            disc1Layout: DiscLayout.contiguous,
        });
    });

    it("embeds the bytes of a local disc, with its name and 40 track layout, whatever it is called", () => {
        const manifest = snapshotMedia(slotsHolding({ disc: localDisc, ref: "session:mine.ssd" }));
        expect(manifest.disc1).toBeUndefined();
        expect(manifest.disc1ImageData).toBe(localDisc.originalImageData);
        expect(manifest.disc1Name).toBe("mine.ssd");
        expect(manifest.disc1Layout).toBe(DiscLayout.expanded40);
    });

    it("records drive 1 under its own keys", () => {
        const manifest = snapshotMedia(slotsHolding(null, { disc: urlDisc, ref: "b.ssd" }));
        expect(manifest.disc2).toBe("b.ssd");
        expect(manifest.disc2Crc32).toBe(0x1234);
    });

    it("names the page's own boot disc, which the URL does not, by the reference its slot knows", () => {
        const manifest = snapshotMedia(slotsHolding({ disc: { ...urlDisc, name: "elite.ssd" }, ref: "elite.ssd" }));
        expect(manifest.disc1).toBe("elite.ssd");
        expect(manifest.disc1Crc32).toBe(0x1234);
    });
});

describe("SnapshotUI", () => {
    let deps;
    let resume;

    beforeEach(() => {
        resume = vi.fn();
        domFromIndexHtml("save-state", "load-state");
        deps = {
            processor: { fdc: { drives: [{ disc: null }, { disc: null }] }, hasTube: false, execute: vi.fn() },
            model: { name: "B-DFS1.2" },
            video: { paint: vi.fn() },
            media: {
                loadDiscImage: vi.fn(),
                slots: { drive: (index) => `drive ${index}`, put: vi.fn(), restored: vi.fn() },
            },
            urlState: { params: {}, urlWith: vi.fn() },
            modals: { showError: vi.fn() },
            loop: { pause: vi.fn(() => resume) },
        };
    });

    afterEach(teardownDom);

    const make = () => new SnapshotUI(deps);

    describe("loading a state", () => {
        it("holds the emulator, reports a file it cannot read, and lets go", async () => {
            await make().loadStateFromFile(null, new Uint8Array([0x00, 0x01, 0x02]).buffer);
            expect(deps.loop.pause).toHaveBeenCalledWith("loading state");
            expect(deps.modals.showError).toHaveBeenCalledWith("loading state", expect.anything());
            expect(resume).toHaveBeenCalledTimes(1);
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
            expect(resume).toHaveBeenCalledTimes(1);
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
            expect(resume).toHaveBeenCalledTimes(1);
        });
    });

    describe("failure with the real error dialog", () => {
        let loop;
        let modals;

        const makeWithModals = () => {
            domFromIndexHtml("error-dialog", "are-you-sure");
            vi.useFakeTimers();
            loop = {
                holds: 0,
                isRunning() {
                    return this.holds === 0;
                },
                pause() {
                    this.holds++;
                    let held = true;
                    return () => {
                        if (held) this.holds--;
                        held = false;
                    };
                },
            };
            modals = new Modals({ loop });
            deps.loop = loop;
            deps.modals = modals;
            return new SnapshotUI(deps);
        };

        const expectPausedBehindDialogThenResumedOnClose = async () => {
            expect(loop.isRunning()).toBe(false);
            await vi.runAllTimersAsync();
            expect(modals.anyVisible()).toBe(true);
            expect(loop.isRunning()).toBe(false);
            modals.hide("error-dialog");
            await vi.runAllTimersAsync();
            expect(modals.anyVisible()).toBe(false);
            expect(loop.isRunning()).toBe(true);
        };

        it("keeps the emulator paused while the save error shows, resuming on close", async () => {
            const ui = makeWithModals();
            deps.processor.snapshotState = vi.fn(() => {
                throw new Error("saving went wrong");
            });
            await ui.saveState();
            await expectPausedBehindDialogThenResumedOnClose();
        });

        it("keeps the emulator paused while the load error shows, resuming on close", async () => {
            const ui = makeWithModals();
            await ui.loadStateFromFile(null, new Uint8Array([0x00, 0x01, 0x02]).buffer);
            await expectPausedBehindDialogThenResumedOnClose();
        });
    });

    describe("reloading a snapshot's media", () => {
        it("does nothing for a snapshot with none", async () => {
            await make().reloadSnapshotMedia(undefined);
            expect(deps.media.slots.put).not.toHaveBeenCalled();
        });

        it("reloads a URL-sourced disc from its source and names it in the URL", async () => {
            const loaded = { name: "ELITE.ssd", originalImageCrc32: 0x1234 };
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await make().reloadSnapshotMedia({ disc1: "sth:ELITE.zip", disc1Crc32: 0x1234 });
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("sth:ELITE.zip", DiscLayout.contiguous);
            expect(deps.media.slots.put).toHaveBeenCalledWith("drive 0", loaded, "sth:ELITE.zip");
            expect(toasts()).toEqual([]);
        });

        it("restores over a disc that keeps its changes at its source, however its bytes have moved on", async () => {
            const loaded = { name: "mine.ssd", originalImageCrc32: 0x9999, savesChanges: true };
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await make().reloadSnapshotMedia({ disc1: "local:mine.ssd", disc1Crc32: 0x1234 });
            expect(deps.media.slots.put).toHaveBeenCalledWith("drive 0", loaded, "local:mine.ssd");
        });

        it("refuses to restore when the source has changed under the state", async () => {
            deps.media.loadDiscImage.mockResolvedValue({ name: "ELITE.ssd", originalImageCrc32: 0x9999 });
            await expect(make().reloadSnapshotMedia({ disc1: "sth:ELITE.zip", disc1Crc32: 0x1234 })).rejects.toThrow(
                "ELITE.ssd has changed since this state was saved",
            );
            expect(deps.media.slots.put).not.toHaveBeenCalled();
        });

        it("refuses to restore over an empty drive when the state has a CRC but no source", async () => {
            await expect(make().reloadSnapshotMedia({ disc1Crc32: 0x1234 })).rejects.toThrow(
                "does not record where the disc in drive 0 came from",
            );
            expect(deps.media.slots.put).not.toHaveBeenCalled();
        });

        it("refuses to restore over a different disc when the state has a CRC but no source", async () => {
            deps.processor.fdc.drives[0].disc = { name: "other.ssd", originalImageCrc32: 0x9999 };
            await expect(make().reloadSnapshotMedia({ disc1Crc32: 0x1234 })).rejects.toThrow(
                "does not hold a matching disc",
            );
            expect(deps.media.slots.put).not.toHaveBeenCalled();
        });

        it("accepts a sourceless state when the drive already holds the matching disc", async () => {
            deps.processor.fdc.drives[0].disc = { name: "elite.ssd", originalImageCrc32: 0x1234 };
            await make().reloadSnapshotMedia({ disc1Crc32: 0x1234 });
            expect(deps.media.slots.put).not.toHaveBeenCalled();
        });

        it("rejects a sourceless state when the matching disc is laid out differently", async () => {
            deps.processor.fdc.drives[0].disc = { name: "elite.ssd", originalImageCrc32: 0x1234, is40Track: true };
            await expect(
                make().reloadSnapshotMedia({ disc1Crc32: 0x1234, disc1Layout: DiscLayout.contiguous }),
            ).rejects.toThrow("does not hold a matching disc");
        });

        it("round-trips the media of a default-boot session", async () => {
            const bootDisc = { name: "elite.ssd", originalImageCrc32: 0x1234, is40Track: false };
            const ui = make();
            const manifest = snapshotMedia({ driveSlots: [{ index: 0, media: bootDisc, ref: "elite.ssd" }] });
            deps.media.loadDiscImage.mockResolvedValue(bootDisc);
            await ui.reloadSnapshotMedia(manifest);
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("elite.ssd", DiscLayout.contiguous);
            expect(deps.media.slots.put).toHaveBeenCalledWith("drive 0", bootDisc, "elite.ssd");
        });

        it("rebuilds an embedded local disc and keeps it out of the URL", async () => {
            const imageData = ssdImage();
            await make().reloadSnapshotMedia({
                disc1ImageData: imageData,
                disc1Name: "mine.ssd",
                disc1Layout: DiscLayout.contiguous,
            });
            const [slot, loadedDisc, ref] = deps.media.slots.put.mock.calls[0];
            expect(slot).toBe("drive 0");
            expect(loadedDisc.name).toBe("mine.ssd");
            expect(loadedDisc.originalImageData).toBeTruthy();
            expect(ref).toBeUndefined();
        });

        it("rebuilds image data that was serialised as a plain object", async () => {
            const imageData = ssdImage();
            await make().reloadSnapshotMedia({
                disc1ImageData: Object.fromEntries(imageData.entries()),
                disc1Name: "mine.ssd",
            });
            expect(deps.media.slots.put).toHaveBeenCalled();
        });

        it("restores drive 1 alongside drive 0", async () => {
            const loaded = { name: "B.ssd" };
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await make().reloadSnapshotMedia({ disc2: "b.ssd" });
            expect(deps.media.slots.put).toHaveBeenCalledWith("drive 1", loaded, "b.ssd");
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
