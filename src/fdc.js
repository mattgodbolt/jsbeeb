// Floppy disc assorted utils.
import { Disc, DiscConfig, loadAdf, loadSsd, toSsdOrDsd } from "./disc.js";
import { loadHfe, toHfe } from "./disc-hfe.js";
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
     * Create a new disc type
     * @param {string} extension - File extension for this disc type (e.g. ".ssd", ".hfe")
     * @param {function(Disc, Uint8Array, function?): Disc} loader - Function to load this disc type
     * @param {function(Disc): Uint8Array} saver - Function to save this disc type
     * @param {function(Uint8Array, string): void|null} nameSetter - Function to set the name/label in the disc image
     * @param {boolean} isDoubleSided - Whether the disc format is double-sided
     * @param {boolean} isDoubleDensity - Whether the disc format is double density
     * @param {number|undefined} byteSize - The size in bytes of this disc format, or undefined if variable
     */
    constructor(extension, loader, saver, nameSetter, isDoubleSided, isDoubleDensity, byteSize) {
        this._extension = extension;
        this._loader = loader;
        this._saver = saver;
        this._nameSetter = nameSetter;
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
const AdfsLargeByteSize = 2 * 80 * 16 * 256; // Double-sided, 16 sectors/track
const AdfsSmallByteSize = 80 * 16 * 256; // Single-sided, 16 sectors/track

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
const hfeDiscType = new DiscType(
    ".hfe",
    loadHfe,
    toHfe,
    null, // no name setter function yet
    true, // double-sided
    true, // double density
    undefined, // variable size
);

// ADFS (Large) discs are double density, double sided
const adlDiscType = new DiscType(
    ".adl",
    (disc, data, _onChange) => {
        // TODO handle onChange
        return loadAdf(disc, data, true);
    },
    (_data) => {
        throw new Error("ADL unsupported");
    },
    null, // no name setter function yet
    true, // double-sided
    true, // double density
    AdfsLargeByteSize,
);

// ADFS (Small) discs are standard ADFS (non-double) density, single sided
const adfDiscType = new DiscType(
    ".adf",
    (disc, data, _onChange) => {
        // TODO handle onChange
        return loadAdf(disc, data, false);
    },
    (_data) => {
        throw new Error("ADF unsupported");
    },
    null, // no name setter function yet
    false, // single-sided
    true, // double density
    AdfsSmallByteSize,
);

// DSD (Double-sided disc)
const dsdDiscType = new DiscType(
    ".dsd",
    (disc, data, onChange) => loadSsd(disc, data, true, onChange),
    toSsdOrDsd,
    setDfsDiscName, // supports setting catalogue name
    true, // double-sided
    false, // standard density
    DsdByteSize,
);

// SSD (Single-sided disc)
const ssdDiscType = new DiscType(
    ".ssd",
    (disc, data, onChange) => loadSsd(disc, data, false, onChange),
    toSsdOrDsd,
    setDfsDiscName, // supports setting catalogue name
    false, // single-sided
    false, // standard density
    SsdByteSize,
);
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
 * Create a disc object of the appropriate type based on the file name
 * @param {Object} fdc - The FDC controller object
 * @param {string} name - The file name with extension
 * @param {string|Uint8Array} stringData - The disc image data as string or Uint8Array
 * @param {function(Uint8Array): void} onChange - Optional callback when disc content changes
 * @returns {Disc} The loaded disc object
 */
export function discFor(fdc, name, stringData, onChange) {
    const data = typeof stringData !== "string" ? stringData : utils.stringToUint8Array(stringData);
    return guessDiscTypeFromName(name).loader(new Disc(true, new DiscConfig(), name), data, onChange);
}

export function localDisc(fdc, name) {
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
    const onChange = (data) => {
        try {
            const str = utils.uint8ArrayToString(data);
            window.localStorage.setItem(discName, str);
        } catch (e) {
            window.alert("Writing to localStorage failed: " + e);
        }
    };
    return discFor(fdc, name, data, onChange);
}
