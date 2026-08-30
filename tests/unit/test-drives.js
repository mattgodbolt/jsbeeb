// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Drives } from "../../src/web/drives.js";
import { DiscLayout } from "../../src/disc.js";
import { DriveTracks } from "../../src/url-params.js";

const Markup = `
<div class="drive-tracks" data-drive="0"><button data-tracks="40">40</button><button data-tracks="80">80</button></div>
<div class="drive-tracks" data-drive="1"><button data-tracks="40">40</button><button data-tracks="80">80</button></div>
<a id="download-drive-link"></a>
<a id="download-drive-hfe-link"></a>`;

/** Enough of an FDC for the page's side of putting a disc in. */
function fakeFdc() {
    const drives = [
        { tracksPerStep: 1, disc: null },
        { tracksPerStep: 1, disc: null },
    ];
    return {
        drives,
        loadDisc: vi.fn((driveIndex, disc, fixed) => {
            drives[driveIndex].disc = disc;
            drives[driveIndex].tracksPerStep = fixed ?? (disc.is40Track ? 2 : 1);
        }),
    };
}

function fakeDisc({ name = "game.ssd", savesChanges = false, is40Track = false } = {}) {
    const disc = { name, savesChanges, is40Track, onFirstWrite: null };
    disc.notifyOnFirstTrackWrite = (callback) => (disc.onFirstWrite = callback);
    return disc;
}

describe("Drives", () => {
    let fdc;
    let areYouSure;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = Markup;
        fdc = fakeFdc();
        areYouSure = vi.fn();
    });

    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = "";
        window.localStorage.clear();
    });

    const make = (driveTracks = [DriveTracks.auto, DriveTracks.auto]) => new Drives({ fdc, driveTracks, areYouSure });
    const toasts = () =>
        [...document.querySelectorAll(".toast")].map((el) => el.textContent.replace(/\s+/g, " ").trim());
    const activeTracks = (driveIndex) =>
        [...document.querySelectorAll(`.drive-tracks[data-drive="${driveIndex}"] .active`)].map(
            (b) => b.dataset.tracks,
        );

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
            expect(activeTracks(0)).toEqual(["40"]);
            expect(activeTracks(1)).toEqual(["80"]);
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
            expect(activeTracks(1)).toEqual(["40"]);
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

    describe("the drive 0 downloads", () => {
        const download = (id) => document.getElementById(id).click();

        it("say so instead of saving when drive 0 is empty", () => {
            make();
            download("download-drive-link");
            download("download-drive-hfe-link");
            expect(toasts()).toEqual([
                expect.stringContaining("no disc in drive 0"),
                expect.stringContaining("no disc in drive 0"),
            ]);
            expect(areYouSure).not.toHaveBeenCalled();
        });

        it("say so instead of throwing on a machine with no drives", () => {
            fdc = undefined;
            make();
            expect(() => download("download-drive-link")).not.toThrow();
            expect(() => download("download-drive-hfe-link")).not.toThrow();
            expect(toasts()).toHaveLength(2);
        });
    });

    describe("the switches on the menu", () => {
        it("set the drive and show what was picked", () => {
            make();
            document.querySelector('.drive-tracks[data-drive="1"] [data-tracks="40"]').click();
            expect(fdc.drives[1].tracksPerStep).toBe(2);
            expect(activeTracks(1)).toEqual(["40"]);
            document.querySelector('.drive-tracks[data-drive="1"] [data-tracks="80"]').click();
            expect(fdc.drives[1].tracksPerStep).toBe(1);
            expect(activeTracks(1)).toEqual(["80"]);
        });

        it("keep the menu open when clicked", () => {
            make();
            const seenByMenu = vi.fn();
            document.querySelector(".drive-tracks").parentElement.addEventListener("click", seenByMenu);
            document.querySelector('[data-tracks="40"]').click();
            expect(seenByMenu).not.toHaveBeenCalled();
        });

        it("are disabled on a machine with no drives", () => {
            fdc = undefined;
            const drives = make();
            for (const button of document.querySelectorAll("[data-tracks]")) expect(button.disabled).toBe(true);
            expect(() => drives.showDriveTracks(0)).not.toThrow();
        });
    });
});
