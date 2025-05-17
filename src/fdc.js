// Floppy disc assorted utils.
import { Disc, DiscConfig, loadAdf, loadSsd } from "./disc.js";
import { loadHfe } from "./disc-hfe.js";
import * as utils from "./utils.js";

export function load(name) {
    console.log("Loading disc from " + name); // todo support zip files
    return utils.loadData(name);
}

export function discFor(fdc, name, stringData, onChange) {
    const data = typeof stringData !== "string" ? stringData : utils.stringToUint8Array(stringData);

    const lowerName = name.toLowerCase();
    const disc = new Disc(true, new DiscConfig(), name);
    // TODO handle onChange for the other disc types.
    if (lowerName.endsWith(".hfe")) return loadHfe(disc, data);
    if (lowerName.endsWith(".adl")) return loadAdf(disc, data, true);
    if (lowerName.endsWith(".adf") || lowerName.endsWith(".adm")) return loadAdf(disc, data, false);
    return loadSsd(disc, data, lowerName.endsWith(".dsd"), onChange);
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
