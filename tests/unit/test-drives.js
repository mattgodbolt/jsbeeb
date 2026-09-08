// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Drives } from "../../src/web/drives.js";
import { DiscLayout } from "../../src/disc.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
import { fakeFdc, fakeUrlState, ssdImage, teardownDom, toasts } from "./helpers.js";

function fakeDisc({ name = "game.ssd", savesChanges = false, is40Track = false } = {}) {
    const disc = { name, savesChanges, is40Track, onFirstWrite: null };
    disc.notifyOnFirstTrackWrite = (callback) => (disc.onFirstWrite = callback);
    return disc;
}

describe("Drives", () => {
    let fdc;
    let confirm;
    let urlState;

    beforeEach(() => {
        vi.useFakeTimers();
        fdc = fakeFdc();
        confirm = vi.fn().mockResolvedValue(false);
        urlState = fakeUrlState();
    });

    afterEach(teardownDom);

    const make = (driveTracks = [DriveTracks.auto, DriveTracks.auto]) =>
        new Drives({ fdc, driveTracks, confirm, urlState });

    describe("what the URL fixed each drive at", () => {
        it("loads an image contiguously for a drive fixed at 80 tracks, and lets the others be detected", () => {
            const drives = make([DriveTracks.eighty, DriveTracks.forty]);
            expect(drives.layoutForDrive(0)).toBe(DiscLayout.contiguous);
            expect(drives.layoutForDrive(1)).toBe(DiscLayout.auto);
            expect(make().layoutForDrive(0)).toBe(DiscLayout.auto);
        });

        it("turns the setting into a tracks-per-step, or nothing when the drive is on auto", () => {
            const drives = make([DriveTracks.forty, DriveTracks.eighty]);
            expect(drives.tracksPerStepForDrive(0)).toBe(2);
            expect(drives.tracksPerStepForDrive(1)).toBe(1);
            expect(make().tracksPerStepForDrive(0)).toBeUndefined();
        });

        it("sets a fixed drive's switch as soon as it is built", () => {
            make([DriveTracks.forty, DriveTracks.auto]);
            expect(fdc.drives[0].tracksPerStep).toBe(2);
            expect(fdc.drives[1].tracksPerStep).toBe(1);
        });

        it("copes with a machine that has no drives", () => {
            fdc = undefined;
            expect(() => make([DriveTracks.forty, DriveTracks.auto])).not.toThrow();
        });
    });

    describe("putDiscIn", () => {
        it("hands the disc and the fixed setting to the FDC", () => {
            const disc = fakeDisc();
            make([DriveTracks.eighty, DriveTracks.auto]).putDiscIn(0, disc);
            expect(fdc.loadDisc).toHaveBeenCalledWith(0, disc, 1);
            expect(fdc.drives[0].disc).toBe(disc);
        });

        it("says when an unfixed drive switched itself for the disc", () => {
            make().putDiscIn(1, fakeDisc({ name: "forty.ssd", is40Track: true }));
            expect(toasts()).toEqual([expect.stringContaining("Drive 1 switched to 40 track for forty.ssd")]);
        });

        it("says nothing when the switch did not move", () => {
            make().putDiscIn(0, fakeDisc());
            expect(toasts()).toEqual([]);
        });

        it("says nothing about a switch the user fixed, whatever the disc", () => {
            make([DriveTracks.forty, DriveTracks.auto]).putDiscIn(0, fakeDisc({ is40Track: false }));
            expect(toasts()).toEqual([]);
        });
    });

    describe("what the drives hold", () => {
        const changes = (drives) => {
            const seen = [];
            drives.addEventListener("disc-changed", (e) => seen.push(e.detail));
            return seen;
        };

        it("says which drive took which disc", () => {
            const drives = make();
            const seen = changes(drives);
            const disc = fakeDisc();
            drives.putDiscIn(1, disc);
            expect(seen).toEqual([{ driveIndex: 1, disc }]);
        });

        it("refuses, in words, on a machine with no drives", () => {
            fdc = undefined;
            expect(() => make().putDiscIn(0, fakeDisc())).toThrow("no disc drives");
        });

        it("takes the last disc asked for, whichever load finishes first", () => {
            const drives = make();
            const first = drives.claim(0);
            const second = drives.claim(0);
            expect(drives.putDiscIn(0, fakeDisc({ name: "second.ssd" }), second)).toBe(true);
            expect(drives.putDiscIn(0, fakeDisc({ name: "first.ssd" }), first)).toBe(false);
            expect(fdc.drives[0].disc.name).toBe("second.ssd");
            expect(drives.holds(0, second)).toBe(true);
        });

        it("lets a disc put in with no claim, or an eject, overtake a load in flight", () => {
            const drives = make();
            const pending = drives.claim(0);
            expect(drives.putDiscIn(0, fakeDisc({ name: "direct.ssd" }))).toBe(true);
            expect(drives.holds(0, pending)).toBe(false);
            const again = drives.claim(1);
            drives.eject(1);
            expect(drives.holds(1, again)).toBe(false);
        });

        it("ejects a disc, leaving the drive empty and saying so", () => {
            const drives = make();
            drives.putDiscIn(0, fakeDisc());
            const seen = changes(drives);
            drives.eject(0);
            expect(fdc.drives[0].disc).toBeUndefined();
            expect(seen).toEqual([{ driveIndex: 0, disc: undefined }]);
        });

        it("keeps a fixed switch where the user put it across an eject", () => {
            const drives = make([DriveTracks.forty, DriveTracks.auto]);
            drives.putDiscIn(0, fakeDisc({ is40Track: false }));
            drives.eject(0);
            expect(fdc.loadDisc).toHaveBeenLastCalledWith(0, undefined, 2);
        });

        it("lets an unfixed switch rest at 80 track once the drive is empty", () => {
            const drives = make();
            drives.putDiscIn(1, fakeDisc({ is40Track: true }));
            drives.eject(1);
            expect(fdc.drives[1].tracksPerStep).toBe(1);
        });
    });

    describe("unsaved writes", () => {
        it("warns on the first write to a disc whose changes go nowhere", () => {
            const disc = fakeDisc({ name: "elite.ssd" });
            make().putDiscIn(0, disc);
            expect(toasts()).toEqual([]);
            disc.onFirstWrite();
            expect(toasts()).toEqual([expect.stringContaining("Changes to elite.ssd are not saved")]);
        });

        it("warns once, however many discs are written", () => {
            const drives = make();
            const first = fakeDisc({ name: "a.ssd" });
            const second = fakeDisc({ name: "b.ssd" });
            drives.putDiscIn(0, first);
            drives.putDiscIn(1, second);
            first.onFirstWrite();
            second.onFirstWrite();
            expect(toasts()).toHaveLength(1);
            drives.putDiscIn(0, fakeDisc({ name: "c.ssd" }));
            expect(fdc.drives[0].disc.onFirstWrite).toBeNull();
        });

        it("does not watch a disc that saves its own changes", () => {
            const disc = fakeDisc({ savesChanges: true });
            make().putDiscIn(0, disc);
            expect(disc.onFirstWrite).toBeNull();
        });
    });

    describe("downloads", () => {
        it("say so instead of saving when the drive is empty", async () => {
            const drives = make();
            await drives.downloadSsdOrDsd(0);
            drives.downloadHfe(1);
            expect(toasts()).toEqual([
                expect.stringContaining("no disc in drive 0"),
                expect.stringContaining("no disc in drive 1"),
            ]);
            expect(confirm).not.toHaveBeenCalled();
        });

        it("give a drive's disc as a sector image, and nothing for an empty drive", async () => {
            const drives = make();
            expect(await drives.sectorImage(1)).toBeNull();
            drives.putDiscIn(0, discFor("a.ssd", ssdImage()));
            const image = await drives.sectorImage(0);
            expect(image.length).toBe(ssdImage().length);
            expect(confirm).not.toHaveBeenCalled();
        });

        it("say so instead of throwing on a machine with no drives", async () => {
            fdc = undefined;
            const drives = make();
            await expect(drives.downloadSsdOrDsd(0)).resolves.toBeUndefined();
            expect(() => drives.downloadHfe(0)).not.toThrow();
            expect(toasts()).toHaveLength(2);
        });
    });

    describe("the 40/80 switch", () => {
        it("moves the drive's switch, pins the drive there in the URL, and says so", () => {
            const drives = make();
            const seen = [];
            drives.addEventListener("tracks-changed", (e) => seen.push(e.detail));
            drives.setTracksPerStep(1, 2);
            expect(fdc.drives[1].tracksPerStep).toBe(2);
            expect(urlState.params).toEqual({ drive1Tracks: "40" });
            expect(drives.tracksPerStepForDrive(1)).toBe(2);
            drives.setTracksPerStep(1, 1);
            expect(fdc.drives[1].tracksPerStep).toBe(1);
            expect(urlState.params).toEqual({ drive1Tracks: "80" });
            expect(seen).toEqual([{ driveIndex: 1 }, { driveIndex: 1 }]);
        });

        it("reads the next disc at the pitch the switch was thrown to", () => {
            const drives = make();
            drives.setTracksPerStep(0, 2);
            drives.putDiscIn(0, fakeDisc({ is40Track: false }));
            expect(fdc.loadDisc).toHaveBeenLastCalledWith(0, expect.anything(), 2);
            expect(toasts()).toEqual([]);
        });

        it("pins a drive that was on auto even when the switch does not move", () => {
            const drives = make();
            const seen = vi.fn();
            drives.addEventListener("tracks-changed", seen);
            drives.setTracksPerStep(0, 1);
            expect(urlState.params).toEqual({ drive0Tracks: "80" });
            expect(seen).toHaveBeenCalledTimes(1);
            drives.setTracksPerStep(0, 1);
            expect(seen).toHaveBeenCalledTimes(1);
        });

        it("does nothing on a machine with no drives", () => {
            fdc = undefined;
            expect(() => make().setTracksPerStep(0, 2)).not.toThrow();
            expect(urlState.params).toEqual({});
        });
    });
});
