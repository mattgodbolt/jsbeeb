/**
 * URL parameter handling for jsbeeb
 */

/**
 * Check if a value is defined (not null and not undefined)
 * @param {*} value - The value to check
 * @returns {boolean} True if the value is neither null nor undefined
 */
function isDefined(value) {
    return value !== null && value !== undefined;
}

/**
 * @typedef {'string'|'array'|'int'|'float'|'bool'} ParamType
 */

/**
 * Parameter type enum to avoid string literals
 * @enum {string}
 */
export const ParamTypes = {
    /** String parameter (default) */
    STRING: "string",
    /** Array parameter (for parameters that can appear multiple times) */
    ARRAY: "array",
    /** Integer parameter */
    INT: "int",
    /** Float parameter */
    FLOAT: "float",
    /** Boolean parameter (true if present, regardless of value) */
    BOOL: "bool",
};

/**
 * Parse a query string into an object
 * @param {string} queryString - The query string to parse
 * @param {Object.<string, ParamType>} [paramTypes={}] - A map of parameter names to their types
 * @returns {Object} Object containing parsed query parameters
 */
export function parseQueryString(queryString, paramTypes = {}) {
    if (!queryString) return {};

    // workaround for shonky python web server
    const cleanQueryString = queryString.endsWith("/") ? queryString.substring(0, queryString.length - 1) : queryString;

    const parsedQuery = {};

    cleanQueryString.split("&").forEach(function (keyval) {
        if (!keyval) return;

        const keyAndVal = keyval.split("=");
        const key = decodeURIComponent(keyAndVal[0]);
        let val = null;
        if (keyAndVal.length > 1) val = decodeURIComponent(keyAndVal[1]);

        const paramType = paramTypes[key] || ParamTypes.STRING;

        switch (paramType) {
            case ParamTypes.ARRAY:
                if (!parsedQuery[key]) {
                    parsedQuery[key] = [];
                }
                parsedQuery[key].push(val);
                break;
            case ParamTypes.INT:
                if (val !== undefined) {
                    const parsed = parseInt(val, 10);
                    parsedQuery[key] = isNaN(parsed) ? 0 : parsed;
                }
                break;
            case ParamTypes.FLOAT:
                if (val !== undefined) {
                    const parsed = parseFloat(val);
                    parsedQuery[key] = isNaN(parsed) ? 0 : parsed;
                }
                break;
            case ParamTypes.BOOL:
                parsedQuery[key] = true; // Presence of parameter means true
                break;
            case ParamTypes.STRING:
            default:
                parsedQuery[key] = val;
                break;
        }
    });

    return parsedQuery;
}

/**
 * Build a URL string from base URL and query parameters
 * @param {string} baseUrl - The base URL (without query string)
 * @param {Object} parsedQuery - Object containing query parameters
 * @param {Object.<string, ParamType>} [paramTypes={}] - Object mapping parameter names to their types
 * @returns {string} The complete URL with query parameters
 */
export function buildUrlFromParams(baseUrl, parsedQuery, paramTypes = {}) {
    let url = baseUrl;
    let sep = "?";

    Object.entries(parsedQuery).forEach(([key, value]) => {
        if (key.length === 0) return;

        const paramType = paramTypes[key] || (Array.isArray(value) ? ParamTypes.ARRAY : ParamTypes.STRING);

        switch (paramType) {
            case ParamTypes.ARRAY:
                // Handle array parameters
                if (Array.isArray(value)) {
                    value.forEach((val) => {
                        if (isDefined(val)) {
                            url += sep + encodeURIComponent(key) + "=" + encodeURIComponent(val);
                            sep = "&";
                        }
                    });
                }
                break;
            case ParamTypes.BOOL:
                // For boolean params, only add the key without value if true
                if (value === true) {
                    url += sep + encodeURIComponent(key);
                    sep = "&";
                }
                break;
            case ParamTypes.INT:
            case ParamTypes.FLOAT:
            case ParamTypes.STRING:
            default:
                // Include the parameter if it has a value (including zero)
                if (isDefined(value) && value !== "") {
                    url += sep + encodeURIComponent(key) + "=" + encodeURIComponent(value);
                    sep = "&";
                }
                break;
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

    // Handle both new boolean values and legacy string values for backward compatibility
    if (parsedQuery.autoboot === true || isDefined(parsedQuery.autoboot)) {
        needsAutoboot = "boot";
    } else if (parsedQuery.autochain === true || isDefined(parsedQuery.autochain)) {
        needsAutoboot = "chain";
    } else if (parsedQuery.autorun === true || isDefined(parsedQuery.autorun)) {
        needsAutoboot = "run";
    } else if (isDefined(parsedQuery.autotype)) {
        needsAutoboot = "type";
        autoType = parsedQuery.autotype;
    }

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
