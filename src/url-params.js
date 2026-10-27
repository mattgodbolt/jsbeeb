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
 * @typedef {"string"|"array"|"int"|"float"|"bool"|"boolDefaultTrue"} ParamType
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
    /** Boolean parameter the page takes as true when absent, so the URL carries it as `key=false` when it is off */
    BOOL_DEFAULT_TRUE: "boolDefaultTrue",
};

/**
 * Parse a query string into an object
 * @param {string} queryString - The query string to parse
 * @param {(name: string) => ParamType|undefined} [typeOf] - The type of the parameter `name`, STRING if none
 * @returns {Object} Object containing parsed query parameters
 */
export function parseQueryString(queryString, typeOf = () => undefined) {
    if (!queryString) return {};

    const parsedQuery = {};

    queryString.split("&").forEach(function (keyval) {
        if (!keyval) return;

        const keyAndVal = keyval.split("=");
        const key = decodeURIComponent(keyAndVal[0]);
        let val = null;
        if (keyAndVal.length > 1) val = decodeURIComponent(keyAndVal.slice(1).join("="));

        const paramType = typeOf(key) ?? ParamTypes.STRING;

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
            case ParamTypes.BOOL_DEFAULT_TRUE:
                // Only the exact 'false' string is treated as false.
                parsedQuery[key] = val !== "false";
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
 * Parse the parameters of a page's location: those in its query, and those after its hash.
 * @param {{search: string, hash: string}} location - A Location or URL
 * @param {(name: string) => ParamType|undefined} [typeOf] - The type of the parameter `name`, STRING if none
 * @returns {Object} Object containing parsed query parameters
 */
export function parseLocationParams(location, typeOf = () => undefined) {
    return parseQueryString(location.search.substring(1) + "&" + location.hash.substring(1), typeOf);
}

/**
 * Characters RFC 3986 allows literally in a query that `encodeURIComponent` escapes anyway. `&`,
 * `=`, `+`, `#`, `%` and space are left escaped because they delimit something, and `?` because a
 * URL with a second one in it reads as broken even though the grammar permits it.
 */
const QueryLiterals = "$,/:;@";

const EscapedQueryLiterals = new RegExp(
    [...QueryLiterals].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join("|"),
    "g",
);

/**
 * Percent-encode a key or value for a query string, escaping only what delimits something
 * @param {string} component - The key or value to encode
 * @returns {string} The encoded component
 */
function encodeQueryComponent(component) {
    return encodeURIComponent(component).replace(EscapedQueryLiterals, decodeURIComponent);
}

/**
 * Append a parameter to the URL
 * @param {string} url - Current URL
 * @param {string} sep - Current separator (? or &)
 * @param {string} key - Parameter key
 * @param {string} [value] - Parameter value (optional for boolean parameters)
 * @returns {Object} Updated URL and separator
 */
function appendParam(url, sep, key, value = undefined) {
    url += sep + encodeQueryComponent(key);
    if (value !== undefined) {
        url += "=" + encodeQueryComponent(value);
    }
    return { url, sep: "&" };
}

/**
 * Build a URL string from base URL and query parameters
 * @param {string} baseUrl - The base URL (without query string)
 * @param {Object} parsedQuery - Object containing query parameters
 * @param {(name: string) => ParamType|undefined} [typeOf] - The type of the parameter `name`, STRING if none
 * @returns {string} The complete URL with query parameters
 */
export function buildUrlFromParams(baseUrl, parsedQuery, typeOf = () => undefined) {
    let url = baseUrl;
    let sep = "?";

    Object.entries(parsedQuery).forEach(([key, value]) => {
        if (key.length === 0) return;

        const paramType = typeOf(key) ?? ParamTypes.STRING;

        switch (paramType) {
            case ParamTypes.ARRAY:
                // Handle array parameters - each item becomes a separate parameter
                if (Array.isArray(value) && value.length > 0) {
                    value.forEach((val) => {
                        if (isDefined(val)) {
                            const result = appendParam(url, sep, key, val);
                            url = result.url;
                            sep = result.sep;
                        }
                    });
                }
                break;
            case ParamTypes.BOOL:
                // For boolean params, only add the key without value if true
                if (value === true) {
                    const result = appendParam(url, sep, key);
                    url = result.url;
                    sep = result.sep;
                }
                break;
            case ParamTypes.BOOL_DEFAULT_TRUE:
                if (typeof value === "boolean") {
                    const result = appendParam(url, sep, key, value ? undefined : "false");
                    url = result.url;
                    sep = result.sep;
                }
                break;
            case ParamTypes.INT:
            case ParamTypes.FLOAT:
            case ParamTypes.STRING:
            default:
                // Include the parameter if it has a value (including zero)
                if (isDefined(value) && value !== "") {
                    const result = appendParam(url, sep, key, value);
                    url = result.url;
                    sep = result.sep;
                }
                break;
        }
    });

    return url;
}

/**
 * Process autoboot and other emulation parameters
 * @param {Object} parsedQuery - The parsed query parameters
 * @returns {{needsAutoboot: "none"|"boot"|"chain"|"run"|"type", autoType: string}} how the page boots
 */
export function processAutobootParams(parsedQuery) {
    let needsAutoboot = "none";
    let autoType = "";

    if (isDefined(parsedQuery.autoboot)) {
        needsAutoboot = "boot";
    } else if (isDefined(parsedQuery.autochain)) {
        needsAutoboot = "chain";
    } else if (isDefined(parsedQuery.autorun)) {
        needsAutoboot = "run";
    } else if (isDefined(parsedQuery.autotype)) {
        needsAutoboot = "type";
        autoType = parsedQuery.autotype;
    }

    return { needsAutoboot, autoType };
}

/** How the page was asked to boot: as `processAutobootParams` says, or `basic` for a BASIC program in the URL. */
export function bootModeOf(parsedQuery) {
    if (parsedQuery.loadBasic || parsedQuery.embedBasic) return "basic";
    return processAutobootParams(parsedQuery).needsAutoboot;
}

/** Where a drive's 40/80 switch is set, `auto` leaving it to whatever disc is loaded. */
export const DriveTracks = Object.freeze({ auto: "auto", forty: "40", eighty: "80" });

const NumDrives = 2;

/**
 * Process the per-drive 40/80 track settings
 * @param {Object} parsedQuery - The parsed query parameters
 * @returns {{settings: string[], warnings: string[]}} One DriveTracks per drive, and what was
 *   unusable about anything asked for that is not in there
 */
export function processDriveTrackParams(parsedQuery) {
    const warnings = [];
    const settings = [];
    for (let driveIndex = 0; driveIndex < NumDrives; ++driveIndex) {
        const name = `drive${driveIndex}Tracks`;
        const asked = parsedQuery[name];
        const setting = isDefined(asked) ? `${asked}`.toLowerCase() : DriveTracks.auto;
        if (Object.values(DriveTracks).includes(setting)) {
            settings.push(setting);
        } else {
            warnings.push(`${name}=${asked}: a drive is set to 40, 80 or auto.`);
            settings.push(DriveTracks.auto);
        }
    }
    return { settings, warnings };
}

/**
 * Guess the appropriate model based on the hostname
 * @param {string} hostname - The hostname to check
 * @returns {string} Model identifier
 */
export function guessModelFromHostname(hostname) {
    if (hostname.startsWith("bbc")) return "B-DFS1.2";
    if (hostname.startsWith("master")) return "Master";
    if (hostname.startsWith("atom")) return "Atom";
    return "B-DFS1.2";
}

/**
 * Parse disc images from the query parameters
 * @param {Object} parsedQuery - The query parameters
 * @returns {Object} Object containing disc information
 *   - discImage: disc image URL (?disc1= or, failing that, ?disc=)
 *   - secondDiscImage: second disc URL (?disc2=)
 *   - mmcImage: MMC/SD card image URL (?mmc=, Atom only)
 */
export function parseMediaParams(parsedQuery) {
    const { disc, disc1, disc2, mmc } = parsedQuery;
    // disc1 is the name the drives use; a bare disc is the older spelling, and gives way to it.
    const discImage = disc1 || disc;

    return { discImage, secondDiscImage: disc2, mmcImage: mmc };
}
