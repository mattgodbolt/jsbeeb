/**
 * URL parameter handling for jsbeeb
 */

/**
 * Parse a query string into an object
 * @param {string} queryString - The query string to parse
 * @param {string[]} [arrayParams=[]] - List of parameter names that should be treated as arrays
 * @returns {Object} Object containing parsed query parameters
 */
export function parseQueryString(queryString, arrayParams = []) {
    if (!queryString) return {};

    // workaround for shonky python web server
    const cleanQueryString = queryString.endsWith("/") ? queryString.substring(0, queryString.length - 1) : queryString;

    const parsedQuery = {};
    const arrayParamsSet = new Set(arrayParams);

    cleanQueryString.split("&").forEach(function (keyval) {
        if (!keyval) return;

        const keyAndVal = keyval.split("=");
        const key = decodeURIComponent(keyAndVal[0]);
        let val = null;
        if (keyAndVal.length > 1) val = decodeURIComponent(keyAndVal[1]);

        // If this parameter should be treated as an array
        if (arrayParamsSet.has(key)) {
            if (!parsedQuery[key]) {
                parsedQuery[key] = [];
            }
            parsedQuery[key].push(val);
        } else {
            parsedQuery[key] = val;
        }
    });

    return parsedQuery;
}

/**
 * Build a URL string from base URL and query parameters
 * @param {string} baseUrl - The base URL (without query string)
 * @param {Object} parsedQuery - Object containing query parameters
 * @returns {string} The complete URL with query parameters
 */
export function buildUrlFromParams(baseUrl, parsedQuery) {
    let url = baseUrl;
    let sep = "?";

    Object.entries(parsedQuery).forEach(([key, value]) => {
        if (key.length === 0) return;

        // Handle array parameters
        if (Array.isArray(value)) {
            value.forEach((val) => {
                if (val !== null && val !== undefined) {
                    url += sep + encodeURIComponent(key) + "=" + encodeURIComponent(val);
                    sep = "&";
                }
            });
        }
        // Handle regular parameters
        else if (value) {
            url += sep + encodeURIComponent(key) + "=" + encodeURIComponent(value);
            sep = "&";
        }
    });

    return url;
}

/**
 * Process keyboard mapping parameters from query string
 * @param {Object} parsedQuery - The parsed query parameters
 * @param {Object} BBC - BBC key constants
 * @param {Object} keyCodes - Key code constants
 * @param {Array} userKeymap - Array to store user key mappings
 * @param {Object} gamepad - Gamepad object for handling mapping
 * @returns {Object} Updated query parameters
 */
export function processKeyboardParams(parsedQuery, BBC, keyCodes, userKeymap, gamepad) {
    Object.entries(parsedQuery).forEach(([key, val]) => {
        if (!val) return;

        // eg KEY.CAPSLOCK=CTRL
        if (key.toUpperCase().indexOf("KEY.") === 0) {
            const bbcKey = val.toUpperCase();

            if (BBC[bbcKey]) {
                const nativeKey = key.substring(4).toUpperCase(); // remove KEY.
                if (keyCodes[nativeKey]) {
                    console.log("mapping " + nativeKey + " to " + bbcKey);
                    userKeymap.push({ native: nativeKey, bbc: bbcKey });
                } else {
                    console.log("unknown key: " + nativeKey);
                }
            } else {
                console.log("unknown BBC key: " + val);
            }
        } else if (key.indexOf("GP.") === 0) {
            // gamepad mapping
            // eg ?GP.FIRE2=RETURN
            const gamepadKey = key.substring(3).toUpperCase(); // remove GP. prefix
            gamepad.remap(gamepadKey, val.toUpperCase());
        } else {
            switch (key) {
                case "LEFT":
                case "RIGHT":
                case "UP":
                case "DOWN":
                case "FIRE":
                    gamepad.remap(key, val.toUpperCase());
                    break;
            }
        }
    });

    return parsedQuery;
}

/**
 * Process autoboot and other emulation parameters
 * @param {Object} parsedQuery - The parsed query parameters
 * @returns {Object} Information about autoboot settings
 */
export function processAutobootParams(parsedQuery) {
    let needsAutoboot = false;
    let autoType = "";

    Object.entries(parsedQuery).forEach(([key, val]) => {
        switch (key) {
            case "autoboot":
                needsAutoboot = "boot";
                break;
            case "autochain":
                needsAutoboot = "chain";
                break;
            case "autorun":
                needsAutoboot = "run";
                break;
            case "autotype":
                needsAutoboot = "type";
                autoType = val;
                break;
        }
    });

    return { needsAutoboot, autoType };
}

/**
 * Guess the appropriate model based on the URL
 * @returns {string} Model identifier
 */
export function guessModelFromUrl() {
    if (window.location.hostname.indexOf("bbc") === 0) return "B-DFS1.2";
    if (window.location.hostname.indexOf("master") === 0) return "Master";
    return "B-DFS1.2";
}

/**
 * Parse disc or tape images from the query parameters
 * @param {Object} parsedQuery - The query parameters
 * @returns {Object} Object containing disc and tape information
 */
export function parseMediaParams(parsedQuery) {
    const discImage = parsedQuery.disc || parsedQuery.disc1;
    const secondDiscImage = parsedQuery.disc2;
    const tapeImage = parsedQuery.tape;

    return { discImage, secondDiscImage, tapeImage };
}
