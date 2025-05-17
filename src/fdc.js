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
     */
    constructor(extension, loader, saver) {
        this._extension = extension;
        this._loader = loader;
        this._saver = saver;
    }
    
    /**
     * Get the file extension for this disc type
     * @returns {string} File extension including dot
     */
    get name() {
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
}
const hfeDiscType = new DiscType(".hfe", loadHfe, toHfe);
const adlDiscType = new DiscType(".adl", (disc, data, _onChange) => {
    // TODO handle onChange
    return loadAdf(disc, data, true);
}, (_data) => {
    throw new Error("ADL unsupported");
});
const adfDiscType = new DiscType(".adf", (disc, data, _onChange) =>{
    // TODO handle onChange
    return loadAdf(disc, data, false);
}, (_data) => {
    throw new Error("ADF unsupported");
});
const dsdDiscType = new DiscType(".dsd", (disc, data, onChange) => loadSsd(disc, data, true, onChange), toSsdOrDsd);
const ssdDiscType = new DiscType(".ssd", (disc, data, onChange) => loadSsd(disc, data, false, onChange), toSsdOrDsd);
/**
 * Determine the disc type based on the file name extension
 * @param {string} name - The file name with extension
 * @returns {DiscType} The appropriate disc type handler
 */
export function guessDiscTypeFromName(name) {
    const lowerName = name.toLowerCase();
    if (lowerName.endsWith(".hfe"))
        return hfeDiscType;
    if (lowerName.endsWith(".adl"))
        return adlDiscType;
    if (lowerName.endsWith(".adf") || lowerName.endsWith(".adm"))
        return adfDiscType;
    if (lowerName.endsWith(".dsd"))
        return dsdDiscType;
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
        data = new Uint8Array(utils.discImageSize(name).byteSize);
        utils.setDiscName(data, name);
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
