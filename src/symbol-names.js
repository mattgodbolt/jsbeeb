/**
 * Which symbol sets match memory, and which name each address takes from them: the matching and
 * precedence rules of "Symbol sets" in beeb-meta-data's proposal,
 * https://github.com/mattgodbolt/beeb-meta-data/blob/main/docs/media-registry-proposal.md.
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
 * @property {Scope[]} scopes
 *
 * @typedef {object} Scope - names for an operand of an instruction in [start, end), and for an address on its own
 *     while the CPU is there; a system set's are ignored
 * @property {number} start
 * @property {number} end - exclusive
 * @property {Map<number, string>} symbols - address to name
 *
 * @typedef {object} SymbolSet
 * @property {string} title
 * @property {string} licence
 * @property {string} source
 * @property {string} [notice]
 * @property {string} [home] - the author's own page
 * @property {string} [nameLink] - a URL template for a name's place on the author's site
 * @property {Map<string, string>} places - name to what `nameLink`'s {place} becomes
 * @property {boolean} system
 * @property {Map<number, string>} globals - address to name
 * @property {Map<number, string>} workspace - address to name, for the set's own code only: an operand of an
 *     instruction in one of its matching regions, and an address on its own while the CPU is in one
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
            this._scopedName(own, at, target) ??
            this._regionName(target, (match) => match === own) ??
            this._globalOf(own.set, target) ??
            this._workspaceOf(own.set, target) ??
            this._regionName(target, (match) => match !== own) ??
            (own.set.system ? undefined : this._systemGlobal(target))
        );
    }

    /**
     * The name for an address shown on its own, with no instruction to say whose it is.
     * @param {number} address
     * @param {number} [pc] - where the CPU is, whose set's workspace names apply and whose globals win a clash
     * @returns {Named | undefined}
     */
    address(address, pc) {
        const own = this._matchAt(address);
        if (own) return this._regionName(address, (match) => match === own);
        const running = this._matchAt(pc);
        const scoped = running && this._scopedName(running, pc, address);
        if (scoped) return scoped;
        const workspace = running && this._workspaceOf(running.set, address);
        if (workspace) return workspace;
        const runningGlobal = running && !running.set.system ? this._globalOf(running.set, address) : undefined;
        if (runningGlobal) return runningGlobal;
        const named = this._matches
            .filter(({ set }) => !set.system)
            .map(({ set }) => this._globalOf(set, address))
            .filter(Boolean);
        if (new Set(named.map(({ name }) => name)).size > 1) return undefined;
        return named[0] ?? this._systemGlobal(address);
    }

    /**
     * Where `name` is, preferring an address shown by that name while the CPU is at `pc`, and then
     * the set whose code the CPU is in.
     * @param {string} name
     * @param {number} [pc]
     * @returns {number | undefined}
     */
    addressOf(name, pc) {
        const running = this._matchAt(pc);
        const candidates = [running, ...this._matches.filter((match) => match !== running)]
            .filter(Boolean)
            .flatMap(({ set, regions }) => [
                ...regions.flatMap((region) => [
                    region.symbols,
                    ...(set.system ? [] : region.scopes.map((scope) => scope.symbols)),
                ]),
                set.globals,
                set.workspace,
            ])
            .flatMap((symbols) => [...symbols].filter(([, named]) => named === name).map(([address]) => address));
        return candidates.find((address) => this.address(address, pc)?.name === name) ?? candidates[0];
    }

    /**
     * The matching region `address` is in, and its set; there is at most one, as overlapping regions don't match.
     * @returns {{region: Region, set: SymbolSet} | undefined}
     */
    regionAt(address) {
        const match = this._matchAt(address);
        return match && { region: match.regions.find((region) => contains(region, address)), set: match.set };
    }

    _matchAt(address) {
        return this._matches.find(({ regions }) => regions.some((region) => contains(region, address)));
    }

    _scopedName(match, at, address) {
        if (match.set.system) return undefined;
        for (const region of match.regions) {
            if (!contains(region, at)) continue;
            for (const scope of region.scopes) {
                const name = contains(scope, at) ? scope.symbols.get(address) : undefined;
                if (name !== undefined) return { name, set: match.set };
            }
        }
        return undefined;
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
        return this._namedBy(set, set.globals, address);
    }

    _workspaceOf(set, address) {
        return this._namedBy(set, set.workspace, address);
    }

    _namedBy(set, names, address) {
        if (set.system && this._inNonSystemRegion(address)) return undefined;
        const name = names.get(address);
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
