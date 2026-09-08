import { DiscLayout } from "../disc.js";
import { discFor, guessDiscTypeFromName } from "../fdc.js";
import { stringToUint8Array, uint8ArrayToString } from "../binary.js";

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
        data = stringToUint8Array(dataString);
    }
    let reportedSaveError = false;
    const onChange = (data) => {
        try {
            const str = uint8ArrayToString(data);
            window.localStorage.setItem(discName, str);
        } catch (e) {
            console.log(`Unable to save browser-local disc ${name}: ${e}`);
            if (reportedSaveError) return;
            reportedSaveError = true;
            onSaveError(e);
        }
    };
    // A fresh disc is kept at once, so it is still there to list if nothing is ever written to it.
    if (!dataString) onChange(data);
    return discFor(name, data, onChange, layout);
}
