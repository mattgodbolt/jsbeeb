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
import * as utils from "./utils.js";

export function load(name) {
    console.log("Loading disc from " + name); // todo support zip files
    return utils.loadData(name);
}

/**
 * Class representing a disc format type with associated loader and saver functions
 */
export class DiscType {
    /**
     * Create a new disc type.
     * @param {Object} [options] - Configuration options for this disc type.
     * @param {string} options.extension - File extension for this disc type (e.g. ".ssd", ".hfe").
     * @param {function(Disc, Uint8Array, function?): Disc} options.loader - Function to load this disc type.
     * @param {function(Disc): Uint8Array} options.saver - Function to save this disc type.
     * @param {function(Uint8Array, string): void|null} [options.nameSetter] - Function to set the name/label in the disc image, or null if not supported.
     * @param {function(Uint8Array): {is40Track: boolean, reason: string}} [options.layoutSniffer] - Function to tell a 40 track image from an 80 track one, for formats that carry the evidence.
     * @param {boolean} [options.isFluxImage] - Whether the image is a picture of the surface rather than a list of the sectors on it.
     * @param {boolean} [options.isDoubleSided] - Whether the disc format is double-sided.
     * @param {boolean} [options.isDoubleDensity] - Whether the disc format is double density.
     * @param {number|undefined} [options.byteSize] - The size in bytes of this disc format, or undefined if variable.
     */
    constructor({
        extension,
        loader,
        saver,
        nameSetter = null,
        layoutSniffer,
        isFluxImage,
        isDoubleSided,
        isDoubleDensity,
        byteSize,
    } = {}) {
        this._extension = extension;
        this._loader = loader;
        this._saver = saver;
        this._nameSetter = nameSetter;
        this._layoutSniffer = layoutSniffer;
        this._isFluxImage = isFluxImage;
        this._isDoubleSided = isDoubleSided;
        this._isDoubleDensity = isDoubleDensity;
        this._byteSize = byteSize;
    }

    /**
     * Get the file extension for this disc type
     * @returns {string} File extension including dot
     */
    get name() {
        return this._extension;
    }

    /**
     * Get the file extension for this disc type
     * @returns {string} File extension including dot
     */
    get extension() {
        return this._extension;
    }

    /**
     * Get the loader function for this disc type
     * @returns {function} Function that loads the disc
     */
    get loader() {
        return this._loader;
    }

    /**
     * Get the saver function for this disc type
     * @returns {function} Function that saves the disc
     */
    get saver() {
        return this._saver;
    }

    /**
     * Get whether this disc format is double-sided
     * @returns {boolean} True if double-sided, false otherwise
     */
    get isDoubleSided() {
        return this._isDoubleSided;
    }

    /**
     * Get whether this disc format is double density
     * @returns {boolean} True if double density, false otherwise
     */
    get isDoubleDensity() {
        return this._isDoubleDensity;
    }

    /**
     * Get the size in bytes of this disc format
     * @returns {number|undefined} The size in bytes, or undefined if variable
     */
    get byteSize() {
        return this._byteSize;
    }

    /**
     * Whether this disc format supports setting a catalogue name
     * @returns {boolean} True if a name setter function exists
     */
    get supportsCatalogue() {
        return this._nameSetter !== null;
    }

    /**
     * Whether the image holds a picture of the surface, so that where its tracks sit is a fact
     * about the disc rather than a decision the loader made.
     * @returns {boolean}
     */
    get isFluxImage() {
        return !!this._isFluxImage;
    }

    /**
     * What an image of this type says about its track layout.
     * @param {Uint8Array} data - The disc image data
     * @returns {?{is40Track: boolean, reason: string}} null for formats that cannot say
     */
    sniffLayout(data) {
        return this._layoutSniffer ? this._layoutSniffer(data) : null;
    }

    /**
     * Sets the disc name in the disc data using the format-specific setter
     * @param {Uint8Array} data - The disc data to modify
     * @param {string} name - The name to set
     * @throws {Error} If the disc format doesn't support setting a name
     */
    setDiscName(data, name) {
        if (!this.supportsCatalogue) {
            throw new Error(`Cannot set disc name for ${this._extension} format`);
        }

        this._nameSetter(data, name);
    }
}
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

// HFE disc type - variable size
const hfeDiscType = new DiscType({
    extension: ".hfe",
    loader: loadHfe,
    saver: toHfe,
    layoutSniffer: sniffHfeLayout,
    isFluxImage: true,
    isDoubleSided: true,
    isDoubleDensity: true,
});

// ADFS (Large) discs are double density, double sided
const adlDiscType = new DiscType({
    extension: ".adl",
    loader: (disc, data, _onChange) => {
        // TODO handle onChange
        return loadAdf(disc, data, true);
    },
    saver: (_data) => {
        throw new Error("ADL unsupported");
    },
    isDoubleSided: true,
    isDoubleDensity: true,
    byteSize: AdfsLargeByteSize,
});

// ADFS M and S: single sided, and sized as the larger of the two.
const adfDiscType = new DiscType({
    extension: ".adf",
    loader: (disc, data, _onChange) => {
        // TODO handle onChange
        return loadAdf(disc, data, false);
    },
    saver: (_data) => {
        throw new Error("ADF unsupported");
    },
    isDoubleSided: false,
    isDoubleDensity: true,
    byteSize: AdfsMediumByteSize,
});

// DSD (Double-sided disc)
const dsdDiscType = new DiscType({
    extension: ".dsd",
    loader: (disc, data, onChange) => loadSsd(disc, data, true, onChange),
    saver: toSsdOrDsd,
    nameSetter: setDfsDiscName,
    layoutSniffer: (data) => sniffDfsLayout(data, true),
    isDoubleSided: true,
    isDoubleDensity: false,
    byteSize: DsdByteSize,
});

// SSD (Single-sided disc)
const ssdDiscType = new DiscType({
    extension: ".ssd",
    loader: (disc, data, onChange) => loadSsd(disc, data, false, onChange),
    saver: toSsdOrDsd,
    nameSetter: setDfsDiscName,
    layoutSniffer: (data) => sniffDfsLayout(data, false),
    isDoubleSided: false,
    isDoubleDensity: false,
    byteSize: SsdByteSize,
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
 * @param {DiscType} discType
 * @param {Uint8Array} data
 * @param {string} name
 * @param {string} layout - one of DiscLayout
 * @returns {boolean} whether to lay the image out for a 40 track drive
 */
function is40TrackLayout(discType, data, name, layout) {
    if (layout !== DiscLayout.auto) return layout === DiscLayout.expanded40;
    const sniffed = discType.sniffLayout(data);
    if (!sniffed) return false;
    console.log(`${name} loaded as ${sniffed.is40Track ? "40" : "80"} track: ${sniffed.reason}`);
    return sniffed.is40Track;
}

/**
 * Create a disc object of the appropriate type based on the file name
 * @param {string} name - The file name with extension
 * @param {string|Uint8Array} stringData - The disc image data as string or Uint8Array
 * @param {function(Uint8Array): void} [onChange] - called when disc content changes
 * @param {string} [layout] - one of DiscLayout; by default the image is asked what it is
 * @returns {Disc} The loaded disc object
 */
export function discFor(name, stringData, onChange, layout = DiscLayout.auto) {
    const data = typeof stringData !== "string" ? stringData : utils.stringToUint8Array(stringData);
    const discType = guessDiscTypeFromName(name);
    const config = new DiscConfig();
    config.expandTo80 = is40TrackLayout(discType, data, name, layout);
    const disc = discType.loader(new Disc(true, config, name), data, onChange);
    // A flux image of a 40 track disc read in an 80 track drive already holds it spread across the
    // surface, so nothing needs moving and only the drive needs telling to step twice.
    if (layout === DiscLayout.auto && discType.isFluxImage && !disc.is40Track) {
        const sniffed = sniffSurfaceLayout(disc);
        disc.is40Track = sniffed.is40Track;
        console.log(`${name} surface reads as ${sniffed.is40Track ? "40" : "80"} track: ${sniffed.reason}`);
    }
    disc.setOriginalImageCrc32(data instanceof Uint8Array ? data : new Uint8Array(data));
    return disc;
}

/**
 * Create or open a disc held in the browser's local storage.
 * @param {string} name - The file name with extension
 * @param {string} [layout] - one of DiscLayout; by default the image is asked what it is
 * @param {function(*): void} [onSaveError] - called with whatever was thrown, the first time a write
 *   cannot be stored
 * @returns {Disc} The loaded disc object
 */
export function localDisc(name, layout = DiscLayout.auto, onSaveError = () => {}) {
    const discName = "disc_" + name;
    let data;
    const dataString = window.localStorage[discName];
    if (!dataString) {
        console.log("Creating browser-local disc " + name);
        const discType = guessDiscTypeFromName(name);
        if (!discType.byteSize) {
            throw new Error(`Cannot create blank disc of type ${discType.extension} - unknown size`);
        }
        data = new Uint8Array(discType.byteSize);
        if (discType.supportsCatalogue) {
            discType.setDiscName(data, name);
        }
    } else {
        console.log("Loading browser-local disc " + name);
        data = utils.stringToUint8Array(dataString);
    }
    let reportedSaveError = false;
    const onChange = (data) => {
        try {
            const str = utils.uint8ArrayToString(data);
            window.localStorage.setItem(discName, str);
        } catch (e) {
            console.log(`Unable to save browser-local disc ${name}: ${e}`);
            if (reportedSaveError) return;
            reportedSaveError = true;
            onSaveError(e);
        }
    };
    return discFor(name, data, onChange, layout);
}
