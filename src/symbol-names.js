/**
 * Which symbol sets match memory, and which name each address takes from them: the matching and
 * precedence rules of "Symbol sets" in docs/media-registry-proposal.md.
 *
 * @typedef {object} Anchor
 * @property {number} at
 * @property {Uint8Array} bytes
 *
 * @typedef {object} Region
 * @property {string} name
 * @property {number} start
 * @property {number} end - exclusive, up to 0x10000
 * @property {number} minAnchors
 * @property {Anchor[]} anchors
 * @property {Map<number, string>} symbols - address to name
 *
 * @typedef {object} SymbolSet
 * @property {string} title
 * @property {string} licence
 * @property {string} source
 * @property {string} [notice]
 * @property {boolean} system
 * @property {Map<number, string>} globals - address to name
 * @property {Region[]} regions
 *
 * @typedef {{set: SymbolSet, regions: Region[]}} Match - a set and those of its regions that match
 * @typedef {{name: string, set: SymbolSet}} Named
 */

/** @param {Region} region @param {(address: number) => number} peek */
export function regionMatches(region, peek) {
    return (
        region.anchors.length >= region.minAnchors &&
        region.anchors.every(({ at, bytes }) => bytes.every((byte, offset) => peek(at + offset) === byte))
    );
}

const contains = (region, address) => address >= region.start && address < region.end;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/**
 * Each holder of regions (a set, or an index entry standing in for one) with those of its regions
 * that match. Where two matching regions overlap, neither counts as matching.
 *
 * @template {{regions: Region[]}} T
 * @param {T[]} holders
 * @param {(address: number) => number} peek
 * @returns {Map<T, Region[]>}
 */
export function matchRegions(holders, peek) {
    const found = holders.flatMap((holder) =>
        holder.regions.filter((region) => regionMatches(region, peek)).map((region) => ({ holder, region })),
    );
    const matches = new Map();
    for (const { holder, region } of found) {
        if (found.some((other) => other.region !== region && overlaps(other.region, region))) continue;
        if (!matches.has(holder)) matches.set(holder, []);
        matches.get(holder).push(region);
    }
    return matches;
}

export class SymbolNames {
    /** @param {Match[]} matches */
    constructor(matches) {
        this._matches = matches;
        this._systemMatches = matches.filter(({ set }) => set.system);
    }

    /** @returns {SymbolSet[]} */
    get sets() {
        return this._matches.map(({ set }) => set);
    }

    /**
     * The name for `target` as an operand of the instruction at `at`.
     * @returns {Named | undefined}
     */
    operand(at, target) {
        const own = this._matchAt(at);
        if (!own) return this._regionName(target) ?? this._systemGlobal(target);
        return (
            this._regionName(target, (match) => match === own) ??
            this._globalOf(own.set, target) ??
            this._regionName(target, (match) => match !== own) ??
            (own.set.system ? undefined : this._systemGlobal(target))
        );
    }

    /**
     * The name for an address shown on its own, with no instruction to say whose it is.
     * @returns {Named | undefined}
     */
    address(address) {
        const own = this._matchAt(address);
        if (own) return this._regionName(address, (match) => match === own);
        const named = this._matches
            .filter(({ set }) => !set.system)
            .map(({ set }) => this._globalOf(set, address))
            .filter(Boolean);
        if (new Set(named.map(({ name }) => name)).size > 1) return undefined;
        return named[0] ?? this._systemGlobal(address);
    }

    _matchAt(address) {
        return this._matches.find(({ regions }) => regions.some((region) => contains(region, address)));
    }

    _regionName(address, which = () => true) {
        for (const match of this._matches) {
            if (!which(match)) continue;
            for (const region of match.regions) {
                const name = contains(region, address) ? region.symbols.get(address) : undefined;
                if (name !== undefined) return { name, set: match.set };
            }
        }
        return undefined;
    }

    _globalOf(set, address) {
        if (set.system && this._inNonSystemRegion(address)) return undefined;
        const name = set.globals.get(address);
        return name === undefined ? undefined : { name, set };
    }

    _systemGlobal(address) {
        for (const { set } of this._systemMatches) {
            const named = this._globalOf(set, address);
            if (named) return named;
        }
        return undefined;
    }

    _inNonSystemRegion(address) {
        return this._matches.some(
            ({ set, regions }) => !set.system && regions.some((region) => contains(region, address)),
        );
    }
}

export const NoNames = new SymbolNames([]);
