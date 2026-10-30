import { compileCondition } from "./conditions.js";
import { hexbyte, hexword } from "./hex.js";
import { requireBank } from "./paging.js";

const Actions = ["stop", "log"];
const AddressSpace = 0x10000;
const LastAddress = AddressSpace - 1;
export const BrkOpcode = 0x00;
const AccessesOfKind = new Map([
    ["execute", ["execute"]],
    ["read", ["read"]],
    ["write", ["write"]],
    ["access", ["read", "write"]],
]);
const HookOfAccess = new Map([
    ["execute", "debugInstruction"],
    ["read", "debugRead"],
    ["write", "debugWrite"],
    ["interrupt", "debugInterrupt"],
]);
const Accesses = [...HookOfAccess.keys()];

/**
 * Makes tests of whether `holds(cpu, entry)` has turned true since the last instruction tested, which the first never
 * has.
 */
function turns(holds) {
    return () => {
        let held = null;
        return (cpu, entry) => {
            const had = held;
            held = holds(cpu, entry);
            return held && had === false;
        };
    };
}

const takenIs = (cpu, entry, address, value, taken) => taken === entry.kind;

/**
 * The kinds with no address: each acts on the instructions, or the interrupts, its test picks out. `firesOn` makes
 * a fresh test, as a test that a change has happened keeps what it saw last.
 */
const EventKinds = new Map([
    ["brk", { access: "execute", firesOn: () => (cpu, entry, address, opcode) => opcode === BrkOpcode }],
    [
        "undocumented",
        {
            access: "execute",
            firesOn: () => (cpu, entry, address, opcode) => !cpu.disassembler.isDocumentedOpcode(opcode),
        },
    ],
    ["irq", { access: "interrupt", firesOn: () => takenIs }],
    ["nmi", { access: "interrupt", firesOn: () => takenIs }],
    ["vsync", { access: "execute", firesOn: turns((cpu) => cpu.video.beamPosition().inVSync) }],
    ["line", { access: "execute", firesOn: turns((cpu, entry) => cpu.video.beamPosition().line === entry.line) }],
]);

/**
 * @typedef {object} BreakpointSpec
 * @property {"execute" | "read" | "write" | "access" | "brk" | "undocumented" | "irq" | "nmi" | "vsync" | "line"} kind -
 * access is a read or a write. The rest have no address: brk and undocumented act before the CPU runs a BRK or an
 * undocumented opcode, irq and nmi as the CPU takes one, before the handler's first instruction, and vsync and line
 * before the first instruction after vsync starts or the beam reaches TV line `line`
 * @property {number} [start] - for an address kind
 * @property {number} [end] - the last address it covers; `start` if not given
 * @property {number} [bank] - only while this sideways bank is paged in where it is hit
 * @property {number} [line] - for a line breakpoint, the TV line, as the beam position counts them
 * @property {string} [condition]
 * @property {(address: number, value: number, pc: number) => boolean} [accepts] - a test of its own, after the
 * condition, for an owner whose rule a condition cannot say, such as a watch's
 * @property {number} [hitCount] - acts on this hit and every one after; 1 if not given
 * @property {boolean} [enabled] - true if not given
 * @property {"stop" | "log"} [action] - stop if not given
 * @property {string} [label]
 * @property {string} [owner] - "user" if not given
 * @property {(hit: BreakpointHit) => void} [onHit]
 */

/**
 * @typedef {object} BreakpointHit
 * @property {number} id
 * @property {BreakpointSpec["kind"]} kind
 * @property {"execute" | "read" | "write" | "interrupt"} access
 * @property {number} address - for an interrupt, its handler's
 * @property {number} [value] - the byte read or written
 * @property {number} [old] - the byte a write replaced
 * @property {number} [line] - a line breakpoint's
 * @property {number} pc - the instruction that made the access; for an interrupt, the one it returns to
 * @property {"stop" | "log"} action
 * @property {number} hits
 */

function requireAddress(what, address) {
    if (!Number.isInteger(address) || address < 0 || address >= AddressSpace)
        throw new Error(`Breakpoint ${what} ${address} is not an address from 0 to $ffff`);
}

/**
 * The CPU's breakpoints, as the debugger, the console and MachineSession all set them. While no enabled breakpoint
 * needs a kind of access, nothing is attached to the CPU's debug hook for it, so the CPU runs as fast as it does with
 * none. Reads include the CPU fetching instructions and their operands.
 */
export class Breakpoints {
    constructor(cpu) {
        this._cpu = cpu;
        this._nextId = 1;
        /** @type {Map<number, object>} */
        this._entries = new Map();
        this._changeListeners = new Set();
        this._hitListeners = new Set();
        this._watching = Object.fromEntries(Accesses.map((access) => [access, null]));
    }

    /**
     * Adds a breakpoint, returning its id. Throws, saying why, if `spec` does not describe one.
     * @param {BreakpointSpec} spec
     * @returns {number}
     */
    add(spec) {
        const checked = this._checked(spec);
        const id = this._nextId++;
        this._entries.set(id, { id, hits: 0, ...checked });
        this._changed();
        return id;
    }

    /** Throws, saying why, if `spec` does not describe a breakpoint this CPU can take. */
    check(spec) {
        this._checked(spec);
    }

    /**
     * Changes the fields `changes` gives of breakpoint `id`, keeping its hits. A new start without an end makes it
     * a single address.
     * @param {number} id
     * @param {Partial<BreakpointSpec>} changes
     */
    update(id, changes) {
        const entry = this._entry(id);
        const spec = { ...this._spec(entry), ...changes };
        if ("start" in changes && !("end" in changes)) spec.end = changes.start;
        this._entries.set(id, { id, hits: entry.hits, ...this._checked(spec) });
        this._changed();
    }

    remove(id) {
        this._entry(id);
        this._entries.delete(id);
        this._changed();
    }

    clear() {
        this._entries.clear();
        this._changed();
    }

    /** Starts each stop waiting for a change afresh, as the machine has jumped to a state it did not run into. */
    forgetSeen() {
        for (const entry of this._entries.values()) entry.fires = EventKinds.get(entry.kind)?.firesOn() ?? null;
    }

    resetHits() {
        for (const entry of this._entries.values()) entry.hits = 0;
        this._notify(this._changeListeners);
    }

    /** @returns {(BreakpointSpec & {id: number, hits: number})} */
    get(id) {
        const entry = this._entry(id);
        return { id, hits: entry.hits, ...this._spec(entry) };
    }

    /** @returns {(BreakpointSpec & {id: number, hits: number})[]} */
    list() {
        return [...this._entries.keys()].map((id) => this.get(id));
    }

    /** Calls `listener()` whenever a breakpoint is added, changed or removed; returns a function that stops it. */
    onChange(listener) {
        this._changeListeners.add(listener);
        return () => this._changeListeners.delete(listener);
    }

    /** Calls `listener(hit)` with each hit that stops or logs; returns a function that stops it. */
    onHit(listener) {
        this._hitListeners.add(listener);
        return () => this._hitListeners.delete(listener);
    }

    _entry(id) {
        const entry = this._entries.get(id);
        if (!entry) throw new Error(`No breakpoint with id ${id}`);
        return entry;
    }

    _spec({ kind, start, end, bank, line, condition, accepts, hitCount, enabled, action, label, owner, onHit }) {
        return { kind, start, end, bank, line, condition, accepts, hitCount, enabled, action, label, owner, onHit };
    }

    _checked({ kind, start, end, bank, line, condition, accepts, hitCount, enabled, action, label, owner, onHit }) {
        const event = EventKinds.get(kind);
        if (!event && !AccessesOfKind.has(kind)) throw new Error(`Unknown breakpoint type: ${kind}`);
        if (event) {
            if (start !== undefined || end !== undefined || bank !== undefined)
                throw new Error(`A ${kind} breakpoint has no address`);
        } else {
            end ??= start;
            requireAddress("start", start);
            requireAddress("end", end);
            if (end < start) throw new Error(`Breakpoint end $${hexword(end)} is before its start $${hexword(start)}`);
            requireBank(bank, this._cpu.model);
        }
        if (kind === "line" && (!Number.isInteger(line) || line < 0))
            throw new Error(`Line ${line} is not a whole number from 0`);
        if (kind !== "line" && line !== undefined) throw new Error(`A ${kind} breakpoint has no line`);
        if (condition !== undefined && typeof condition !== "string")
            throw new Error(`Breakpoint condition ${condition} is not text`);
        condition = condition?.trim() || undefined;
        if (enabled !== undefined && typeof enabled !== "boolean")
            throw new Error(`Breakpoint enabled ${enabled} is not true or false`);
        if (label !== undefined && typeof label !== "string") throw new Error(`Breakpoint label ${label} is not text`);
        if (owner !== undefined && typeof owner !== "string") throw new Error(`Breakpoint owner ${owner} is not text`);
        hitCount ??= 1;
        if (!Number.isInteger(hitCount) || hitCount < 1)
            throw new Error(`Hit count ${hitCount} is not a whole number from 1`);
        action ??= "stop";
        if (!Actions.includes(action)) throw new Error(`Breakpoint action ${action} is not stop or log`);
        return {
            kind,
            start,
            end,
            bank,
            line,
            accesses: event ? [event.access] : AccessesOfKind.get(kind),
            from: start ?? 0,
            to: end ?? LastAddress,
            fires: event?.firesOn() ?? null,
            condition,
            test: condition === undefined ? null : compileCondition(condition),
            hitCount,
            enabled: enabled ?? true,
            action,
            label,
            owner: owner ?? "user",
            accepts,
            onHit,
        };
    }

    _changed() {
        for (const access of Accesses) this._watch(access);
        this._notify(this._changeListeners);
    }

    _notify(listeners, ...args) {
        for (const listener of listeners) listener(...args);
    }

    /** Attaches the hook for `access` while an enabled breakpoint needs it, and only then. */
    _watch(access) {
        const entries = [...this._entries.values()].filter((entry) => entry.enabled && entry.accesses.includes(access));
        const watching = this._watching[access];
        if (!entries.length) {
            watching?.handler.remove();
            this._watching[access] = null;
            return;
        }
        const covered = new Uint8Array(AddressSpace);
        for (const { from, to } of entries) covered.fill(1, from, to + 1);
        const handler = watching?.handler ?? this._cpu[HookOfAccess.get(access)].add(this._handler(access));
        this._watching[access] = { handler, entries, covered };
    }

    _handler(access) {
        if (access === "interrupt") return (taken, returnsTo) => this._check(access, this._cpu.pc, 0, returnsTo, taken);
        return (address, value) => this._check(access, address, value & 0xff, undefined, undefined);
    }

    /** `returnsTo` and `taken`, "irq" or "nmi", are an interrupt's. */
    _check(access, address, value, returnsTo, taken) {
        // A handler earlier in the same dispatch can remove the last breakpoint, detaching this one before its call.
        const watching = this._watching[access];
        if (!watching?.covered[address]) return false;
        const { entries } = watching;
        const cpu = this._cpu;
        // An instruction a stop halted before runs on resuming; no execute breakpoint stops it a second time.
        if (access === "execute" && cpu.resumingFromStop) return false;
        const old = access === "write" ? cpu.peekmem(address) : value;
        const pc = { execute: address, interrupt: returnsTo }[access] ?? cpu.getPrevPc(0);
        let stop = false;
        for (const entry of entries) {
            if (address < entry.from || address > entry.to) continue;
            if (entry.fires && !entry.fires(cpu, entry, address, value, taken)) continue;
            if (entry.bank !== undefined && !cpu.isBankPagedAt(entry.bank, address)) continue;
            if (entry.test && !entry.test(cpu, pc, value, old)) continue;
            if (entry.accepts && !entry.accepts(address, value, pc)) continue;
            if (++entry.hits < entry.hitCount) continue;
            const hit = {
                id: entry.id,
                kind: entry.kind,
                access,
                address,
                pc,
                action: entry.action,
                hits: entry.hits,
            };
            if (access === "read" || access === "write") hit.value = value;
            if (access === "write") hit.old = old;
            if (entry.line !== undefined) hit.line = entry.line;
            if (entry.action === "stop") stop = true;
            entry.onHit?.(hit);
            this._notify(this._hitListeners, hit);
        }
        return stop;
    }
}

const EventPhrases = new Map([
    ["brk", () => "BRK"],
    ["undocumented", () => "undocumented opcode"],
    ["vsync", () => "vsync"],
    ["line", (line) => `line ${line}`],
]);

/** A line describing `hit`, as the console shows a logged one. */
export function describeHit({ id, kind, access, address, value, old, pc, line, hits }) {
    const what = {
        execute: () => EventPhrases.get(kind)?.(line) ?? `execute $${hexword(address)}`,
        read: () => `read $${hexbyte(value)} from $${hexword(address)}`,
        write: () => `write $${hexbyte(value)} (was $${hexbyte(old)}) to $${hexword(address)}`,
        interrupt: () => `${kind.toUpperCase()} to $${hexword(address)}`,
    }[access]();
    const at = access === "interrupt" ? "from" : "at";
    return `Breakpoint ${id}: ${what} ${at} pc $${hexword(pc)}, hit ${hits}`;
}
