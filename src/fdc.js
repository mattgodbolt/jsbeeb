// Floppy disc assorted utils.
import {
    Disc,
    DiscConfig,
    DiscLayout,
    loadAdf,
    loadSsd,
    sniffDfsLayout,
    sniffSurfaceLayout,
    toSsdOrDsd,
} from "./disc.js";
import { loadHfe, sniffHfeLayout, toHfe } from "./disc-hfe.js";
import { stringToUint8Array } from "./binary.js";
import { loadData } from "./loader.js";
import { DiscDrive } from "./disc-drive.js";

/**
 * What a disc controller reports to its log, for the Disc controller panel to spell out: a command, its result, a
 * change of state or of the control register, a note on what it did, or a warning of something unusual. The other
 * fields depend on the kind and the chip.
 * @typedef {{kind: "command" | "result" | "state" | "control" | "note" | "warning"} & Object<string, *>} FdcLogEntry
 */

/**
 * What the 8271 and the WD1770 share: two drives, a timer, a log, and the calls the rest of jsbeeb makes. Each chip
 * supplies `chip` (its name), `_timerFired()` and `_pulsesCallback(pulses, count)`.
 */
export class DiscController {
    /**
     * @param {import("./6502.js").Cpu6502} cpu
     * @param {import("./scheduler.js").Scheduler} scheduler
     * @param {DiscDrive[] | undefined} drives
     */
    constructor(cpu, scheduler, drives) {
        this._cpu = cpu;
        this._scheduler = scheduler;
        this._drives = drives ?? [
            new DiscDrive(0, scheduler, cpu.peripheralCyclesPerSecond),
            new DiscDrive(1, scheduler, cpu.peripheralCyclesPerSecond),
        ];
        /** @type {DiscDrive|null} */
        this._currentDrive = null;
        this._lastSelectedDrive = this._drives[0];
        this._timerTask = this._scheduler.newTask(() => this._timerFired());

        this.logCommands = false;
        this.logStateChanges = false;
        /** @type {((entry: FdcLogEntry) => void) | null} */
        this.onLog = null;

        for (const drive of this._drives) {
            drive.setPulsesCallback((pulses, count) => {
                if (drive === this._currentDrive) this._pulsesCallback(pulses, count);
            });
        }
    }

    _log(entry) {
        this.onLog?.(entry);
    }

    _note(text) {
        if (this.logCommands) this._log({ kind: "note", text });
    }

    _warn(text) {
        console.warn(`${this.chip}: ${text}`);
        this._log({ kind: "warning", text });
    }

    /**
     * @param {Number} drive
     * @param {Disc} disc
     * @param {Number} [tracksPerStep] where to leave the drive's 40/80 switch, which by default
     *   follows the disc, since no drive can tell what pitch the disc in it was written at
     */
    loadDisc(drive, disc, tracksPerStep = disc?.is40Track ? 2 : 1) {
        this._drives[drive].setDisc(disc);
        this._drives[drive].tracksPerStep = tracksPerStep;
    }

    /** Each drive's activity light, which follows its select line: the controller's select gated by the motor. */
    get motorOn() {
        return [0, 1].map((i) => !!this._drives[i]?.spinning && this._drives[i] === this._currentDrive);
    }

    get drives() {
        return this._drives;
    }

    /** The timer and drive state each chip's snapshotState ends with. */
    _snapshotTimerAndDrives() {
        return {
            timerTaskOffset: this._timerTask.offset(),
            drives: this._drives.map((d) => d.snapshotState()),
        };
    }

    _restoreDrives(state) {
        for (let i = 0; i < this._drives.length; i++) this._drives[i].restoreState(state.drives[i]);
    }
}

export function load(name) {
    return loadData(name);
}

/**
 * A disc image format: how to load and save it, and what it can say about itself.
 * @typedef {Object} DiscType
 * @property {string} extension including the dot
 * @property {function(Disc, Uint8Array, function?): Disc} loader
 * @property {function(Disc): Uint8Array} saver
 * @property {number|undefined} byteSize undefined for a format of no fixed size
 * @property {boolean} isFluxImage whether the image is a picture of the surface, so that where its tracks sit is a
 *   fact about the disc rather than a decision the loader made
 * @property {(function(Uint8Array, string): void)|null} setDiscName null for a format with no catalogue to title
 * @property {(function(Uint8Array): {is40Track: boolean, reason: string})|null} sniffLayout null for a format that
 *   cannot tell a 40 track image from an 80 track one
 */

// Standard sizes
const SsdByteSize = 80 * 10 * 256; // 80 tracks, 10 sectors, 256 bytes/sector
const DsdByteSize = SsdByteSize * 2; // Double-sided
// ADFS comes in three sizes: S is 40 tracks on one side, M is 80 on one, L is 80 on both.
const AdfsMediumByteSize = 80 * 16 * 256;
const AdfsLargeByteSize = AdfsMediumByteSize * 2;

/**
 * Set the name in a DFS disc image (SSD/DSD format)
 * @param {Uint8Array} data - The disc data to modify
 * @param {string} name - The name to set (up to 8 characters)
 */
function setDfsDiscName(data, name) {
    for (let i = 0; i < 8; ++i) {
        data[i] = i < name.length ? name.charCodeAt(i) & 0xff : 0x20; // padded with spaces
    }
}

/** @type {DiscType} */
const hfeDiscType = Object.freeze({
    extension: ".hfe",
    loader: loadHfe,
    saver: toHfe,
    byteSize: undefined,
    isFluxImage: true,
    setDiscName: null,
    sniffLayout: sniffHfeLayout,
});

/** @type {DiscType} */
const adlDiscType = Object.freeze({
    extension: ".adl",
    // TODO(#822) handle onChange
    loader: (disc, data, _onChange) => loadAdf(disc, data, true),
    saver: (_disc) => {
        throw new Error("ADL unsupported");
    },
    byteSize: AdfsLargeByteSize,
    isFluxImage: false,
    setDiscName: null,
    sniffLayout: null,
});

// ADFS M and S: single sided, and sized as the larger of the two.
/** @type {DiscType} */
const adfDiscType = Object.freeze({
    extension: ".adf",
    // TODO(#822) handle onChange
    loader: (disc, data, _onChange) => loadAdf(disc, data, false),
    saver: (_disc) => {
        throw new Error("ADF unsupported");
    },
    byteSize: AdfsMediumByteSize,
    isFluxImage: false,
    setDiscName: null,
    sniffLayout: null,
});

/** @type {DiscType} */
const dsdDiscType = Object.freeze({
    extension: ".dsd",
    loader: (disc, data, onChange) => loadSsd(disc, data, true, onChange),
    saver: toSsdOrDsd,
    byteSize: DsdByteSize,
    isFluxImage: false,
    setDiscName: setDfsDiscName,
    sniffLayout: (data) => sniffDfsLayout(data, true),
});

/** @type {DiscType} */
const ssdDiscType = Object.freeze({
    extension: ".ssd",
    loader: (disc, data, onChange) => loadSsd(disc, data, false, onChange),
    saver: toSsdOrDsd,
    byteSize: SsdByteSize,
    isFluxImage: false,
    setDiscName: setDfsDiscName,
    sniffLayout: (data) => sniffDfsLayout(data, false),
});

/**
 * Determine the disc type based on the file name extension
 * @param {string} name - The file name with extension
 * @returns {DiscType} The appropriate disc type handler
 */
export function guessDiscTypeFromName(name) {
    const lowerName = name.toLowerCase();
    if (lowerName.endsWith(".hfe")) return hfeDiscType;
    if (lowerName.endsWith(".adl")) return adlDiscType;
    if (lowerName.endsWith(".adf") || lowerName.endsWith(".adm")) return adfDiscType;
    if (lowerName.endsWith(".dsd")) return dsdDiscType;
    return ssdDiscType;
}

/**
 * @param {DiscType} discType a format of fixed size
 * @param {string} name
 * @returns {Uint8Array} an empty sector image, its catalogue titled from `name` where the format has one
 */
export function blankImage(discType, name) {
    if (!discType.byteSize) throw new Error(`Cannot create blank disc of type ${discType.extension} - unknown size`);
    const data = new Uint8Array(discType.byteSize);
    discType.setDiscName?.(data, name);
    return data;
}

const layoutNote = ({ is40Track, reason }) => ({
    text: `${is40Track ? "40" : "80"} track, as ${reason}`,
    isOdd: false,
});

/**
 * Create a disc object of the appropriate type based on the file name
 * @param {string} name - The file name with extension
 * @param {string|Uint8Array} stringData - The disc image data as string or Uint8Array
 * @param {function(Uint8Array): void} [onChange] - called when disc content changes
 * @param {string} [layout] - one of DiscLayout; by default the image is asked what it is
 * @returns {Disc} The loaded disc object
 */
export function discFor(name, stringData, onChange, layout = DiscLayout.auto) {
    const data = typeof stringData !== "string" ? stringData : stringToUint8Array(stringData);
    const discType = guessDiscTypeFromName(name);
    const config = new DiscConfig();
    const sniffed = layout === DiscLayout.auto ? (discType.sniffLayout?.(data) ?? null) : null;
    config.expandTo80 = sniffed ? sniffed.is40Track : layout === DiscLayout.expanded40;
    const disc = discType.loader(new Disc(true, config, name), data, onChange);
    let reading = sniffed;
    // A flux image of a 40 track disc read in an 80 track drive already holds it spread across the
    // surface, so nothing needs moving and only the drive needs telling to step twice.
    if (layout === DiscLayout.auto && discType.isFluxImage && !disc.is40Track) {
        // Both heads move together, so a disc has one pitch and the side that boots can speak for it.
        reading = sniffSurfaceLayout(disc, false);
        disc.is40Track = reading.is40Track;
    }
    if (reading) disc.loadNotes.unshift(layoutNote(reading));
    disc.setOriginalImageCrc32(data instanceof Uint8Array ? data : new Uint8Array(data));
    return disc;
}
