import { DiscLayout } from "../disc.js";
import { blankImage, discFor, guessDiscTypeFromName } from "../fdc.js";
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
        data = blankImage(guessDiscTypeFromName(name), name);
    } else {
        data = stringToUint8Array(dataString);
    }
    let reportedSaveError = false;
    const onChange = (data) => {
        try {
            const str = uint8ArrayToString(data);
            window.localStorage.setItem(discName, str);
        } catch (e) {
            if (reportedSaveError) return;
            reportedSaveError = true;
            onSaveError(e);
        }
    };
    // A fresh disc is kept at once, so it is still there to list if nothing is ever written to it.
    if (!dataString) onChange(data);
    return discFor(name, data, onChange, layout);
}
