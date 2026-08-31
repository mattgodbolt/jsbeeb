import { toast } from "./toast.js";
import { DiscLayout, toSsdOrDsd } from "../disc.js";
import { toHfe } from "../disc-hfe.js";
import { downloadDriveData } from "../dom-utils.js";
import { DriveTracks } from "../url-params.js";

const tracksPerStepFor = (tracks) => (tracks === "40" ? 2 : 1);

/**
 * The disc drives as the page sees them: putting a disc in, the 40/80 track
 * switches on the Discs menu, and downloading what is in drive 0.
 */
export class Drives {
    constructor({ fdc, driveTracks, confirm }) {
        this.fdc = fdc;
        this.driveTracks = driveTracks;
        this.saidWritesAreNotKept = false;

        for (const item of document.querySelectorAll(".drive-tracks")) {
            const driveIndex = Number(item.dataset.drive);
            const drive = fdc?.drives[driveIndex];
            const fixed = drive ? this.tracksPerStepForDrive(driveIndex) : undefined;
            if (fixed !== undefined) drive.tracksPerStep = fixed;
            for (const button of this.driveTracksButtons(driveIndex)) {
                button.disabled = !drive;
                button.addEventListener("click", (event) => {
                    // Setting a switch is not picking from a menu, so leave the menu where it is.
                    event.stopPropagation();
                    drive.tracksPerStep = tracksPerStepFor(button.dataset.tracks);
                    this.showDriveTracks(driveIndex);
                });
            }
            if (drive) this.showDriveTracks(driveIndex);
        }

        document.getElementById("download-drive-link").addEventListener("click", async () => {
            const disc = this.discToDownload();
            if (!disc) return;
            const save = (options) =>
                downloadDriveData(toSsdOrDsd(disc, options), disc.name, disc.isDoubleSided ? ".dsd" : ".ssd");
            try {
                save();
            } catch (e) {
                if (await confirm(`${e.message} Save anyway, losing what will not fit?`, "Save anyway", "Cancel"))
                    save({ force: true });
            }
        });

        document.getElementById("download-drive-hfe-link").addEventListener("click", () => {
            const disc = this.discToDownload();
            if (!disc) return;
            downloadDriveData(toHfe(disc), disc.name, ".hfe");
        });
    }

    /** @returns {import("../disc.js").Disc|null} the disc in drive 0, saying so when there is nothing to download */
    discToDownload() {
        const disc = this.fdc?.drives[0].disc;
        if (!disc) toast("There is no disc in drive 0 to download.", { title: "Disc" });
        return disc ?? null;
    }

    /** @returns {string} the DiscLayout to load an image for this drive with */
    layoutForDrive(driveIndex) {
        return this.driveTracks[driveIndex] === DriveTracks.eighty ? DiscLayout.contiguous : DiscLayout.auto;
    }

    /** @returns {Number|undefined} the tracksPerStep the user fixed this drive at, if they fixed one */
    tracksPerStepForDrive(driveIndex) {
        if (this.driveTracks[driveIndex] === DriveTracks.auto) return undefined;
        return this.driveTracks[driveIndex] === DriveTracks.forty ? 2 : 1;
    }

    putDiscIn(driveIndex, loadedDisc) {
        const drive = this.fdc.drives[driveIndex];
        const fixed = this.tracksPerStepForDrive(driveIndex);
        const was = drive.tracksPerStep;
        this.fdc.loadDisc(driveIndex, loadedDisc, fixed);
        this.showDriveTracks(driveIndex);
        this.noteUnsavedWrites(loadedDisc);
        // A switch the user fixed does not move, so anything it does is not news.
        if (fixed === undefined && drive.tracksPerStep !== was) this.noteDriveTracks(driveIndex, loadedDisc.name);
    }

    noteUnsavedWrites(loadedDisc) {
        if (loadedDisc.savesChanges || this.saidWritesAreNotKept) return;
        loadedDisc.notifyOnFirstTrackWrite(() => {
            if (this.saidWritesAreNotKept) return;
            this.saidWritesAreNotKept = true;
            toast(`Changes to ${loadedDisc.name} are not saved. Use Discs, Download to keep a copy.`, {
                title: "Disc",
                quietKey: "quietDiscNotSaved",
            });
        });
    }

    showDriveTracks(driveIndex) {
        const drive = this.fdc?.drives[driveIndex];
        if (!drive) return;
        for (const button of this.driveTracksButtons(driveIndex))
            button.classList.toggle("active", tracksPerStepFor(button.dataset.tracks) === drive.tracksPerStep);
    }

    driveTracksButtons(driveIndex) {
        return document.querySelectorAll(`.drive-tracks[data-drive="${driveIndex}"] [data-tracks]`);
    }

    noteDriveTracks(driveIndex, discName) {
        const tracks = this.fdc.drives[driveIndex].tracksPerStep === 2 ? "40" : "80";
        toast(`Drive ${driveIndex} switched to ${tracks} track for ${discName}.`, {
            title: "Disc drive",
            quietKey: "quietDriveTracks",
        });
    }
}
