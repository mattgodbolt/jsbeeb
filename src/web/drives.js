import { toast } from "./toast.js";
import { DiscLayout, toSsdOrDsd } from "../disc.js";
import { toHfe } from "../disc-hfe.js";
import { downloadDriveData } from "./dom-utils.js";
import { DriveTracks } from "../url-params.js";

/** The 40/80 switch's label for a drive stepping `tracksPerStep` physical tracks per logical one. */
export const tracksLabel = (tracksPerStep) => (tracksPerStep === 2 ? "40" : "80");
export const tracksPerStepOf = (label) => (label === "40" ? 2 : 1);

/**
 * The disc drives as the page sees them: putting a disc in and taking it out,
 * each drive's 40/80 track switch, and downloading what a drive holds.
 * Raises "tracks-changed" when a switch moves.
 */
export class Drives extends EventTarget {
    constructor({ fdc, driveTracks, confirm, urlState }) {
        super();
        this.fdc = fdc;
        this.driveTracks = driveTracks;
        this.confirm = confirm;
        this.urlState = urlState;
        this.saidWritesAreNotKept = false;

        for (const driveIndex of [0, 1]) {
            const drive = fdc?.drives[driveIndex];
            const fixed = drive ? this.tracksPerStepForDrive(driveIndex) : undefined;
            if (fixed !== undefined) drive.tracksPerStep = fixed;
        }
    }

    /** @returns {import("../disc.js").Disc|null} the disc in the drive, saying so when there is nothing to download */
    discToDownload(driveIndex) {
        const disc = this.fdc?.drives[driveIndex].disc;
        if (!disc) toast(`There is no disc in drive ${driveIndex} to download.`, { title: "Disc" });
        return disc ?? null;
    }

    /**
     * A drive's disc as a sector image, asking first when a track would not fit one.
     *
     * @returns {Promise<Uint8Array|null>} the image, or null when there is none to give
     */
    async sectorImage(driveIndex) {
        const disc = this.discToDownload(driveIndex);
        if (!disc) return null;
        try {
            return toSsdOrDsd(disc);
        } catch (e) {
            if (await this.confirm(`${e.message} Save anyway, losing what will not fit?`, "Save anyway", "Cancel"))
                return toSsdOrDsd(disc, { force: true });
            return null;
        }
    }

    /** Downloads a drive's disc as a sector image, asking first if a flux-only track would be lost. */
    async downloadSsdOrDsd(driveIndex) {
        const image = await this.sectorImage(driveIndex);
        if (!image) return;
        const disc = this.fdc.drives[driveIndex].disc;
        downloadDriveData(image, disc.name, disc.isDoubleSided ? ".dsd" : ".ssd");
    }

    /** Downloads a drive's disc as HFE, the format that keeps every flux transition. */
    downloadHfe(driveIndex) {
        const disc = this.discToDownload(driveIndex);
        if (!disc) return;
        downloadDriveData(toHfe(disc), disc.name, ".hfe");
    }

    /** @returns {string} the DiscLayout to load an image for this drive with */
    layoutForDrive(driveIndex) {
        return this.driveTracks[driveIndex] === DriveTracks.eighty ? DiscLayout.contiguous : DiscLayout.auto;
    }

    /** @returns {Number|undefined} the tracksPerStep the user fixed this drive at, if they fixed one */
    tracksPerStepForDrive(driveIndex) {
        if (this.driveTracks[driveIndex] === DriveTracks.auto) return undefined;
        return tracksPerStepOf(this.driveTracks[driveIndex]);
    }

    /**
     * Throws a drive's 40/80 switch: the disc in it now is read at that pitch, and so is
     * whatever is put in next, until the switch is thrown again.
     */
    setTracksPerStep(driveIndex, tracksPerStep) {
        const drive = this.fdc?.drives[driveIndex];
        if (!drive) return;
        const setting = tracksLabel(tracksPerStep);
        if (drive.tracksPerStep === tracksPerStep && this.driveTracks[driveIndex] === setting) return;
        drive.tracksPerStep = tracksPerStep;
        this.driveTracks[driveIndex] = setting;
        this.urlState.set({ [`drive${driveIndex}Tracks`]: setting });
        this.dispatchEvent(new CustomEvent("tracks-changed", { detail: { driveIndex } }));
    }

    putDiscIn(driveIndex, loadedDisc) {
        if (!this.fdc) throw new Error("This machine has no disc drives");
        const drive = this.fdc.drives[driveIndex];
        const fixed = this.tracksPerStepForDrive(driveIndex);
        const was = drive.tracksPerStep;
        this.fdc.loadDisc(driveIndex, loadedDisc, fixed);
        this.noteUnsavedWrites(loadedDisc);
        // A switch the user fixed does not move, so anything it does is not news.
        if (fixed === undefined && drive.tracksPerStep !== was) this.noteDriveTracks(driveIndex, loadedDisc.name);
    }

    eject(driveIndex) {
        this.fdc.loadDisc(driveIndex, undefined, this.tracksPerStepForDrive(driveIndex));
    }

    noteUnsavedWrites(loadedDisc) {
        if (loadedDisc.savesChanges || this.saidWritesAreNotKept) return;
        loadedDisc.notifyOnFirstTrackWrite(() => {
            if (this.saidWritesAreNotKept) return;
            this.saidWritesAreNotKept = true;
            toast(`Changes to ${loadedDisc.name} are not saved. Use the drive's Save button to keep a copy.`, {
                title: "Disc",
                quietKey: "quietDiscNotSaved",
            });
        });
    }

    noteDriveTracks(driveIndex, discName) {
        const tracks = tracksLabel(this.fdc.drives[driveIndex].tracksPerStep);
        toast(`Drive ${driveIndex} switched to ${tracks} track for ${discName}.`, {
            title: "Disc drive",
            quietKey: "quietDriveTracks",
        });
    }
}
