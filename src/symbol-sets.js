import { loadData } from "./loader.js";
import { matchRegions, NoNames, SymbolNames } from "./symbol-names.js";

/** @typedef {import("./symbol-names.js").SymbolSet} SymbolSet */
/** @typedef {import("./symbol-names.js").Region} Region */

export const Format = 1;
const AddressSpace = 0x10000;
const FirstRetryDelayMs = 5000;
const MaxRetryDelayMs = 5 * 60 * 1000;
export const RelativeJsonPath = /^(?:[\w-]+\/)*[\w-][\w.-]*\.json$/;

/** "0x1a2c" as a number; only a region's end can be 0x10000. */
export function parseAddress(text, what, limit = AddressSpace - 1) {
    const digits = /^0x([0-9a-f]{1,5})$/.exec(text)?.[1];
    const value = digits === undefined ? NaN : parseInt(digits, 16);
    if (!(value <= limit))
        throw new Error(`${what} is "${text}", which is not an address up to 0x${limit.toString(16)}`);
    return value;
}

function parseBytes(text, what) {
    if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error(`${what} is "${text}", which is not lowercase hex bytes`);
    return Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));
}

function parseNames(names, what) {
    const byAddress = new Map();
    for (const [name, address] of Object.entries(names ?? {}))
        byAddress.set(parseAddress(address, `${what} ${name}`), name);
    return byAddress;
}

/** @returns {Region} */
function parseRegion(name, region) {
    const what = `region ${name}`;
    const start = parseAddress(region.start, `${what}'s start`);
    const end = parseAddress(region.end, `${what}'s end`, AddressSpace);
    if (end <= start) throw new Error(`${what} ends before it starts`);
    const anchors = (region.anchors ?? []).map((anchor, i) => ({
        at: parseAddress(anchor.at, `${what}'s anchor ${i}`),
        bytes: parseBytes(anchor.bytes, `${what}'s anchor ${i}'s bytes`),
    }));
    const minAnchors = region.minAnchors ?? 1;
    if (!Number.isInteger(minAnchors) || minAnchors < 1)
        throw new Error(`${what}'s minAnchors is ${minAnchors}, not a whole number of at least 1`);
    return { name, start, end, minAnchors, anchors, symbols: parseNames(region.symbols, `${what}'s symbol`) };
}

function parseRegions(regions) {
    return Object.entries(regions ?? {}).map(([name, region]) => parseRegion(name, region));
}

function checkFormat(json, what) {
    if (json?.format !== Format) throw new Error(`${what} has format ${json?.format}, not ${Format}`);
}

/**
 * A set file as the debugger uses it. Throws on anything it can't read; the build's checks are
 * stricter (tools/symbols/build-index.js).
 * @returns {SymbolSet}
 */
export function parseSet(json) {
    checkFormat(json, "the set");
    return {
        title: json.title,
        licence: json.licence,
        source: json.source,
        notice: json.notice,
        system: json.system === true,
        globals: parseNames(json.globals, "global"),
        regions: parseRegions(json.regions),
    };
}

/**
 * The index's entries, each a set's location, relative to the index, and its regions without
 * their symbols.
 * @returns {{url: string, regions: Region[]}[]}
 */
export function parseIndex(json) {
    checkFormat(json, "the index");
    return json.sets.map((entry, i) => {
        if (!RelativeJsonPath.test(entry.url))
            throw new Error(`the index's set ${i} is at "${entry.url}", which is not a JSON file beside the index`);
        return { url: entry.url, regions: parseRegions(entry.regions) };
    });
}

async function loadJson(url) {
    return JSON.parse(new TextDecoder().decode(await loadData(url)));
}

/** One file's fetches: at most one at a time, and after a failure, none until a delay that doubles each time. */
class Fetches {
    constructor() {
        this.inFlight = false;
        this.failures = 0;
        this.retryAt = 0;
    }

    ready(now) {
        return !this.inFlight && now >= this.retryAt;
    }

    failed(now) {
        this.retryAt = now + Math.min(FirstRetryDelayMs * 2 ** this.failures, MaxRetryDelayMs);
        this.failures++;
    }
}

/**
 * The symbol sets under a base URL: its `index.json`, fetched the first time names are wanted, and
 * each set it lists, fetched once its regions match. Dispatches "loaded" when a fetch brings
 * something new, since the names for memory that hasn't changed may be different now.
 */
export class SymbolSets extends EventTarget {
    /**
     * @param {object} options
     * @param {string | URL} options.baseUrl - an absolute URL ending in a slash
     * @param {(url: string) => Promise<object>} [options.load] - fetches and parses one JSON file
     * @param {() => number} [options.now] - milliseconds, for the delay before a retry
     */
    constructor({ baseUrl, load = loadJson, now = () => Date.now() }) {
        super();
        this._indexUrl = new URL("index.json", baseUrl).href;
        this._load = load;
        this._now = now;
        this._indexFetches = new Fetches();
        /** @type {{url: string, regions: Region[], set: SymbolSet | null, fetches: Fetches}[] | null} */
        this._entries = null;
    }

    /**
     * The names for memory as `peek` reads it now, from the sets already fetched; starts fetching
     * the index, or the sets that match and haven't been fetched yet.
     * @param {(address: number) => number} peek
     * @returns {SymbolNames}
     */
    names(peek) {
        if (!this._entries) {
            this._fetch(this._indexFetches, this._indexUrl, (json) => {
                this._entries = parseIndex(json).map(({ url, regions }) => ({
                    url: new URL(url, this._indexUrl).href,
                    regions,
                    set: null,
                    fetches: new Fetches(),
                }));
            });
            return NoNames;
        }
        const matches = [];
        for (const [entry, regions] of matchRegions(this._entries, peek)) {
            if (entry.set) {
                matches.push({ set: entry.set, regions });
                continue;
            }
            this._fetch(entry.fetches, entry.url, (json) => {
                entry.set = parseSet(json);
                entry.regions = entry.set.regions;
            });
        }
        return matches.length ? new SymbolNames(matches) : NoNames;
    }

    async _fetch(fetches, url, use) {
        if (!fetches.ready(this._now())) return;
        fetches.inFlight = true;
        try {
            use(await this._load(url));
        } catch (error) {
            fetches.failed(this._now());
            console.warn(`Couldn't load the symbols in ${url}, so addresses stay plain for now: ${error.message}`);
            return;
        } finally {
            fetches.inFlight = false;
        }
        this.dispatchEvent(new Event("loaded"));
    }
}
