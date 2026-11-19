// The device the VDFS ROM in roms-src/vdfs talks to: four ports in FRED. The ROM pokes a call's A, X and Y in, then the
// call's number to start it, waits on the go port while the host does the call, then reads the response back from A (the
// ops it is to carry out, then the A the call returns) and X and Y. See docs/vdfs.md.

import { Errors, VdfsError, printable } from "./vdfs-errors.js";

export const PortBase = 0xfc60;
/** How much of FRED the ports take. */
export const PortBytes = 4;
export const Port = Object.freeze({ go: 0, a: 1, x: 2, y: 3 });
export const HostId = 0x16;
export const IdMask = 0x3f;
export const VdfsRom = "vdfs.rom";
/** What a read of the go port says: the host is still doing the call. */
export const Busy = 0x80;
/** What a read of the go port says: the carry the call returns, once the response's ops are read. */
export const CarryOut = 0x40;
/** What a read of a port gives while a replay runs the ROM, which must not reach the folder: a host that is idle. */
export const inertRead = (offset) => (offset === Port.go ? HostId : 0);

export const Call = Object.freeze({ service: 0, file: 1, args: 2, bget: 3, bput: 4, gbpb: 5, find: 6, fsc: 7 });
export const Op = Object.freeze({ done: 0, print: 1, error: 2, exec: 3, claim: 4 });

const MaxErrorText = 80;
const HostFailureNumber = 0xff;
const LastAscii = 0x7e;
const FirstPrintable = 0x20;
const CarriageReturn = 0x0d;
const Unprintable = "?".charCodeAt(0);
const MaxResponses = 16;

/** Thrown inside a call that a break has overtaken, which has no one left to answer. */
export class Superseded extends Error {}

/** What the ROM is to do once a call has been made, as the bytes it reads from the A port. */
export class Response {
    constructor() {
        this.bytes = [];
        this.ended = false;
        this.raises = false;
    }

    _text(text) {
        for (const char of text) {
            const code = char.charCodeAt(0);
            const isPrintable = (code >= FirstPrintable && code <= LastAscii) || code === CarriageReturn;
            this.bytes.push(isPrintable ? code : Unprintable);
        }
        this.bytes.push(0);
    }

    print(text) {
        this.bytes.push(Op.print);
        this._text(text);
    }

    error(number, text) {
        this.bytes.push(Op.error, number);
        this._text(text.slice(0, MaxErrorText));
        this.ended = true;
        this.raises = true;
    }

    /** The ROM jumps to the program at `address`, with the caller's return address still on the stack. */
    exec(address) {
        const less = (address - 1) & 0xffff;
        this.bytes.push(Op.exec, less >> 8, less & 0xff);
        this.ended = true;
    }

    claim() {
        this.bytes.push(Op.claim);
    }
}

/** What a call is given to say whether it is still the one the machine is waiting for. */
class Turn {
    constructor(ports, epoch) {
        this._ports = ports;
        this._epoch = epoch;
    }

    get current() {
        return this._epoch === this._ports._epoch;
    }

    /** Throws if a break has overtaken the call, so that it does not go on to change a machine that has restarted. */
    check() {
        if (!this.current) throw new Superseded();
    }
}

/** The response that raises `error` on the 6502. */
function errorResponse({ number, message }) {
    const response = new Response();
    response.error(number, message);
    return response;
}

const byte = (value) => (Number.isInteger(value) ? value & 0xff : 0);

export class VdfsPorts {
    /**
     * @param {(call: number, registers: {a: number, x: number, y: number, p: number}, response: Response, turn: Turn) => void | Promise<void>} dispatch
     *   does a call, and may take its time over it: the ROM waits. It is given the A, X and Y the ROM poked in, and
     *   what it leaves in them, and in bit 0 of `p`, is what the ROM gets back.
     */
    constructor(dispatch) {
        this._dispatch = dispatch;
        this._inputs = { a: 0, x: 0, y: 0 };
        this._responses = [];
        this._busy = false;
        this._epoch = 0;
    }

    /** How many responses the ROM has not finished reading. */
    get openResponses() {
        return this._responses.length;
    }

    /** Ends a call that is waiting with an error, for when what it was waiting for is not there any more. */
    abort(error) {
        if (!this._busy) return;
        this._epoch++;
        this._answerWith(errorResponse(error));
    }

    /** What the device holds between one of the ROM's reads and the next, for a snapshot to restore the ROM mid-call. */
    snapshotState() {
        return {
            inputs: { ...this._inputs },
            busy: this._busy,
            responses: this._responses.map(({ bytes, position, results, raises }) => [
                [...bytes],
                position,
                results && { ...results },
                raises,
            ]),
        };
    }

    /** A call that was waiting is answered with "Disc changed". What a snapshot file has wrong is left out or made a byte. */
    restoreState(state) {
        this.reset();
        const inputs = state?.inputs ?? {};
        this._inputs = { a: byte(inputs.a), x: byte(inputs.x), y: byte(inputs.y) };
        const saved = Array.isArray(state?.responses) ? state.responses.slice(-MaxResponses) : [];
        for (const entry of saved) {
            const [bytes, position, results, raises] = Array.isArray(entry) ? entry : [];
            if (!Array.isArray(bytes) || !Number.isInteger(position)) continue;
            const kept = results && { x: byte(results.x), y: byte(results.y), carry: results.carry ? 1 : 0 };
            this._responses.push({
                bytes: bytes.map(byte),
                position: Math.min(Math.max(position, 0), bytes.length),
                results: kept ?? null,
                raises: Boolean(raises),
            });
        }
        if (state?.busy) this._answerWith(errorResponse(Errors.discChanged()));
    }

    /** A break: a call under way has no one to answer, and no response is left unread. */
    reset() {
        this._epoch++;
        this._busy = false;
        this._inputs = { a: 0, x: 0, y: 0 };
        this._responses.length = 0;
    }

    read(offset) {
        switch (offset) {
            case Port.go:
                return this._status();
            case Port.a:
                return this._nextByte();
            case Port.x:
                return this._responses.at(-1)?.results?.x ?? 0;
            case Port.y:
                return this._responses.at(-1)?.results?.y ?? 0;
            default:
                return 0;
        }
    }

    write(offset, value) {
        switch (offset) {
            case Port.go:
                this._call(value);
                break;
            case Port.a:
                this._inputs.a = value;
                break;
            case Port.x:
                this._inputs.x = value;
                break;
            case Port.y:
                this._inputs.y = value;
                break;
        }
    }

    _status() {
        if (this._busy) return Busy | HostId;
        return HostId | (this._responses.at(-1)?.results?.carry ? CarryOut : 0);
    }

    /**
     * The next byte of the response being read, which is the newest: calls the ROM makes while it carries out ops
     * (`*SPOOL`) finish before it goes on. A response that is not there was cut off by a break, a restored snapshot or a
     * call from an interrupt, and what reads it is told the disc changed. The last byte of a response frees it, and the
     * last byte of an error frees them all, since the BRK it raises never returns into what the ROM was doing.
     */
    _nextByte() {
        if (this._responses.length === 0) this._push(errorResponse(Errors.discChanged()));
        const response = this._responses.at(-1);
        const value = response.bytes[response.position++];
        if (response.position >= response.bytes.length) {
            this._responses.pop();
            if (response.raises) this._responses.length = 0;
        }
        return value ?? 0;
    }

    /**
     * Starts a call. A call that finishes at once is answered at once; one that does not leaves the go port busy
     * until it has. A call that fails is answered with an error, one that is a bug in the host with one that says so.
     */
    _call(call) {
        const turn = new Turn(this, ++this._epoch);
        const registers = { ...this._inputs, p: 0 };
        const response = new Response();
        this._busy = true;
        const answer = (error) => {
            if (!turn.current) return;
            if (error instanceof VdfsError) response.error(error.number, error.message);
            else if (error !== undefined) {
                console.error("VDFS host failure:", error);
                response.error(HostFailureNumber, `VDFS host failure: ${printable(error.message)}`);
            }
            if (response.ended) return this._answerWith(response);
            const results = { x: byte(registers.x), y: byte(registers.y), carry: registers.p & 1 };
            this._answerWith({ bytes: [...response.bytes, Op.done, byte(registers.a)], raises: false }, results);
        };
        let outcome;
        try {
            outcome = this._dispatch(call, registers, response, turn);
        } catch (error) {
            answer(error);
            return;
        }
        if (outcome instanceof Promise)
            outcome.then(
                () => answer(),
                (error) => (error instanceof Superseded ? undefined : answer(error)),
            );
        else answer();
    }

    /** Makes `{ bytes, raises }` and `results` the answer the ROM reads next. */
    _answerWith(response, results = null) {
        this._push(response, results);
        this._busy = false;
    }

    /** The oldest response is dropped if the ROM has left this many unread. */
    _push({ bytes, raises }, results = null) {
        if (this._responses.length >= MaxResponses) this._responses.shift();
        this._responses.push({ bytes, position: 0, results, raises });
    }
}
