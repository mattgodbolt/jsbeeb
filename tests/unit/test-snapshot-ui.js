// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SnapshotUI, isSnapshotFile, snapshotMedia } from "../../src/web/snapshot-ui.js";
import { Modals } from "../../src/web/modals.js";
import { DiscLayout } from "../../src/disc.js";
import { MediaSlots } from "../../src/web/media-slots.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
import {
    domFromIndexHtml,
    fakeFdc,
    fakeUrlState,
    sentEvents,
    ssdImage,
    stubNavigation,
    teardownDom,
    toasts,
} from "./helpers.js";

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

describe("isSnapshotFile", () => {
    it.each([
        ["state.snp", true],
        ["state.json", true],
        ["state.json.gz", true],
        ["elite.ssd", false],
        ["tape.uef", false, new Uint8Array([1, 2, 3]).buffer],
    ])("judges %s a state: %s", (name, isState, bytes) => {
        expect(isSnapshotFile(name, bytes)).toBe(isState);
    });
});

describe("SnapshotUI", () => {
    let deps;
    let resume;

    beforeEach(() => {
        resume = vi.fn();
        domFromIndexHtml("save-state", "load-state");
        deps = {
            processor: {
                fdc: { drives: [{ disc: null }, { disc: null }] },
                hasTube: false,
                execute: vi.fn(),
                debugInstruction: { stopped: false },
            },
            model: { name: "B-DFS1.2" },
            video: { paint: vi.fn() },
            media: {
                loadDiscImage: vi.fn(),
                slots: { restored: vi.fn() },
            },
            urlState: { params: {}, urlWith: vi.fn() },
            modals: { showError: vi.fn() },
            loop: { hold: vi.fn(() => resume), stop: vi.fn(), replacingState: vi.fn() },
        };
    });

    afterEach(teardownDom);

    const make = () => new SnapshotUI(deps);
    const unreadable = new Uint8Array([0x00, 0x01, 0x02]).buffer;
    const snapshotJson = (snapshot) =>
        JSON.stringify({
            format: "jsbeeb-snapshot",
            version: 3,
            model: "B-DFS1.2",
            coProcessor: false,
            state: {},
            ...snapshot,
        });
    const snapshotBuffer = (snapshot) => new TextEncoder().encode(snapshotJson(snapshot)).buffer;

    it("notes saving and loading a state as the State menu's", async () => {
        const sent = sentEvents();
        vi.spyOn(console, "error").mockImplementation(() => {});
        const menu = document.createElement("ul");
        menu.dataset.feature = "state";
        menu.append(document.getElementById("save-state"));
        document.body.append(menu);
        const ui = make();
        deps.processor.snapshotState = vi.fn(() => {
            throw new Error("not this time");
        });
        await ui.saveState();
        await ui.loadStateFromFile(null, unreadable);
        expect(sent("feature_used")).toEqual([
            { feature: "state", action: "save" },
            { feature: "state", action: "load" },
        ]);
    });

    describe("loading a state", () => {
        it.each([
            [
                "another model",
                "?disc1=elite.ssd&autoboot",
                { model: "Master" },
                "https://bbc.example/?disc1=elite.ssd&model=Master",
            ],
            ["a co-processor it lacks", "", { coProcessor: true }, "https://bbc.example/?model=B-DFS1.2&coProcessor"],
        ])(
            "stashes a state for %s and reloads as that machine, without the page's own boot",
            async (_, search, snapshot, reloadedAs) => {
                deps.urlState = stubNavigation(fakeUrlState(search));
                await make().loadStateFromFile(null, snapshotBuffer(snapshot));
                expect(deps.urlState.navigatedTo).toBe(reloadedAs);
                expect(window.location.hash).toBe("#navigated");
                expect(JSON.parse(sessionStorage.getItem("jsbeeb-pending-state"))).toMatchObject(snapshot);
                expect(deps.video.paint).not.toHaveBeenCalled();
                expect(resume).toHaveBeenCalledTimes(1);
            },
        );

        it("restores a matching state in place and repaints", async () => {
            deps.processor.restoreState = vi.fn();
            await make().loadStateFromFile(null, snapshotBuffer());
            expect(deps.processor.restoreState).toHaveBeenCalledWith({});
            expect(deps.loop.replacingState).toHaveBeenCalled();
            expect(deps.video.paint).toHaveBeenCalledTimes(1);
            expect(deps.modals.showError).not.toHaveBeenCalled();
            expect(sessionStorage.getItem("jsbeeb-pending-state")).toBeNull();
            expect(deps.loop.stop).not.toHaveBeenCalled();
            expect(resume).toHaveBeenCalledTimes(1);
        });

        it("stops in the debugger at a state saved where a breakpoint stopped it", async () => {
            deps.processor.restoreState = () => {
                deps.processor.debugInstruction.stopped = true;
            };
            await make().loadStateFromFile(null, snapshotBuffer());
            expect(deps.loop.stop).toHaveBeenCalledWith(true);
            expect(deps.video.paint).toHaveBeenCalledTimes(1);
            expect(resume).toHaveBeenCalledTimes(1);
        });
    });

    describe("failure with the real error dialog", () => {
        it.each([
            [
                "save",
                "saving state",
                (ui) => {
                    deps.processor.snapshotState = () => {
                        throw new Error("saving went wrong");
                    };
                    return ui.saveState();
                },
            ],
            ["load", "loading state", (ui) => ui.loadStateFromFile(null, unreadable)],
        ])("keeps the emulator paused while the %s error shows, resuming on close", async (_, doing, fail) => {
            domFromIndexHtml("error-dialog", "are-you-sure");
            vi.useFakeTimers();
            const loop = {
                holds: 0,
                replacingState() {},
                isRunning() {
                    return this.holds === 0;
                },
                hold() {
                    this.holds++;
                    let held = true;
                    return () => {
                        if (held) this.holds--;
                        held = false;
                    };
                },
            };
            const modals = new Modals({ loop });
            Object.assign(deps, { loop, modals });
            await fail(make());
            expect(loop.isRunning()).toBe(false);
            await vi.runAllTimersAsync();
            expect(modals.anyVisible()).toBe(true);
            expect(document.querySelector("#error-dialog .context").textContent).toBe(doing);
            expect(loop.isRunning()).toBe(false);
            modals.hide("error-dialog");
            await vi.runAllTimersAsync();
            expect(modals.anyVisible()).toBe(false);
            expect(loop.isRunning()).toBe(true);
        });
    });

    describe("reloading a snapshot's media", () => {
        let fdc;
        let slots;
        let sent;

        beforeEach(() => {
            sent = sentEvents();
            fdc = fakeFdc();
            deps.urlState = fakeUrlState();
            const drives = new Drives({
                fdc,
                driveTracks: [DriveTracks.auto, DriveTracks.auto],
                urlState: deps.urlState,
            });
            slots = new MediaSlots({ loader: deps.media, drives, processor: { fdc }, urlState: deps.urlState });
            deps.processor.fdc = fdc;
            deps.media.slots = slots;
        });

        const ssd = (name) => discFor(name, ssdImage());
        const crc = ssd("any.ssd").originalImageCrc32;
        const reload = (manifest) => make().reloadSnapshotMedia(manifest);

        it("does nothing for a snapshot with none", async () => {
            await reload(undefined);
            expect(deps.media.loadDiscImage).not.toHaveBeenCalled();
            expect(fdc.drives.map((drive) => drive.disc)).toEqual([undefined, undefined]);
        });

        it("reloads a URL-sourced disc from its source and names it in the URL, but not as loaded recently", async () => {
            const loaded = ssd("ELITE.ssd");
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await reload({ disc1: "sth:ELITE.zip", disc1Crc32: crc });
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("sth:ELITE.zip", DiscLayout.contiguous);
            expect(fdc.drives[0].disc).toBe(loaded);
            expect(deps.urlState.params).toEqual({ disc1: "sth:ELITE.zip" });
            expect(slots.recent.entries).toEqual([]);
            expect(sent("media_load")).toEqual([expect.objectContaining({ slot: "drive0", entry: "restore" })]);
            expect(toasts()).toEqual([]);
        });

        it("restores drive 1 alongside drive 0", async () => {
            const loaded = ssd("B.ssd");
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await reload({ disc2: "b.ssd" });
            expect(fdc.drives[1].disc).toBe(loaded);
            expect(deps.urlState.params).toEqual({ disc2: "b.ssd" });
        });

        it("restores over a disc that keeps its changes at its source, however its bytes have moved on", async () => {
            const loaded = ssd("mine.ssd");
            loaded.addTrackWriteListener(() => {}, true);
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await reload({ disc1: "local:mine.ssd", disc1Crc32: crc + 1 });
            expect(fdc.drives[0].disc).toBe(loaded);
            expect(slots.drive(0).ref).toBe("local:mine.ssd");
        });

        it("refuses to restore when the source has changed under the state", async () => {
            deps.media.loadDiscImage.mockResolvedValue(ssd("ELITE.ssd"));
            await expect(reload({ disc1: "sth:ELITE.zip", disc1Crc32: crc + 1 })).rejects.toThrow(
                "ELITE.ssd has changed since this state was saved",
            );
            expect(fdc.drives[0].disc).toBeUndefined();
        });

        it.each([
            ["an empty drive", undefined, {}, "does not record where the disc in drive 0 came from"],
            ["a different disc", { originalImageCrc32: 0x9999 }, {}, "does not hold a matching disc"],
            [
                "the matching disc laid out differently",
                { originalImageCrc32: 0x1234, is40Track: true },
                { disc1Layout: DiscLayout.contiguous },
                "does not hold a matching disc",
            ],
        ])("refuses a state with a CRC but no source over %s", async (_, inDrive, manifest, message) => {
            fdc.drives[0].disc = inDrive;
            await expect(reload({ disc1Crc32: 0x1234, ...manifest })).rejects.toThrow(message);
            expect(fdc.drives[0].disc).toBe(inDrive);
        });

        it("accepts a sourceless state when the drive already holds the matching disc", async () => {
            const inDrive = { name: "elite.ssd", originalImageCrc32: 0x1234 };
            fdc.drives[0].disc = inDrive;
            await reload({ disc1Crc32: 0x1234 });
            expect(fdc.drives[0].disc).toBe(inDrive);
            expect(deps.media.loadDiscImage).not.toHaveBeenCalled();
        });

        it("round-trips the media of a default-boot session", async () => {
            const bootDisc = ssd("elite.ssd");
            slots.put(slots.drive(0), bootDisc, "elite.ssd", { inUrl: false });
            const manifest = snapshotMedia(slots);
            slots.eject(slots.drive(0));
            deps.media.loadDiscImage.mockResolvedValue(bootDisc);
            await reload(manifest);
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("elite.ssd", DiscLayout.contiguous);
            expect(fdc.drives[0].disc).toBe(bootDisc);
            expect(slots.drive(0).ref).toBe("elite.ssd");
        });

        it.each([
            ["as bytes", (image) => image],
            ["serialised as a plain object", (image) => Object.fromEntries(image.entries())],
        ])("rebuilds an embedded local disc from its image %s and keeps it out of the URL", async (_, asSaved) => {
            const image = ssdImage();
            await reload({ disc1ImageData: asSaved(image), disc1Name: "mine.ssd", disc1Layout: DiscLayout.contiguous });
            expect(fdc.drives[0].disc.name).toBe("mine.ssd");
            expect(fdc.drives[0].disc.originalImageCrc32).toBe(crc);
            expect(slots.drive(0).ref).toBeUndefined();
            expect(deps.urlState.params).toEqual({});
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
            sessionStorage.setItem("jsbeeb-pending-state", snapshotJson({ state: { stashed: true } }));
            await make().restorePendingState();
            expect(deps.processor.restoreState).toHaveBeenCalledWith({ stashed: true });
            expect(deps.processor.execute).toHaveBeenCalledWith(40000);
            expect(deps.modals.showError).not.toHaveBeenCalled();
            expect(sessionStorage.getItem("jsbeeb-pending-state")).toBeNull();
        });

        it("stops a stashed state saved at a breakpoint in the debugger, without settling the machine", async () => {
            deps.processor.restoreState = () => {
                deps.processor.debugInstruction.stopped = true;
            };
            sessionStorage.setItem("jsbeeb-pending-state", snapshotJson());
            await make().restorePendingState();
            expect(deps.loop.stop).toHaveBeenCalledWith(true);
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
