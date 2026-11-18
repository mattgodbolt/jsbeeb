// The device the VDFS ROM in roms-src/vdfs talks to: ports in FRED that the ROM pokes a call's A, X and Y into, then
// its number to start it, waits on while the host does the call, and reads A, X, Y and the carry back from, with a
// stream of ops for it to carry out where the host wants the 6502 to do something. See docs/vdfs.md.

import { Errors, VdfsError, printable } from "./vdfs-errors.js";

export const PortBase = 0xfc60;
/** How much of FRED the ports take. */
export const PortBytes = 16;
export const Port = Object.freeze({
    go: 0,
    aIn: 1,
    xIn: 2,
    yIn: 3,
    aRes: 4,
    xRes: 5,
    yRes: 6,
    stream: 7,
    data: 8,
    id: 9,
});
export const HostId = 0x56;
export const VdfsRom = "vdfs.rom";
/** What a read of the go port says: the host is still doing the call. */
export const Busy = 0x80;
/** What a read of the go port says: the host has ops for the 6502 that it has not yet read. */
export const OpsWaiting = 0x40;
/** What a read of the go port says: the carry the call returns, for the response being read. */
export const CarryOut = 0x01;
/** What a read of a port gives while a replay runs the ROM, which must not reach the folder: a host that is idle. */
export const inertRead = (offset) => (offset === Port.id ? HostId : 0);

export const Call = Object.freeze({ service: 0, file: 1, args: 2, bget: 3, bput: 4, gbpb: 5, find: 6, fsc: 7 });
export const Op = Object.freeze({ done: 0, print: 1, error: 2, exec: 3, claim: 4 });

const MaxErrorText = 80;
const HostFailureNumber = 0xff;
const LastAscii = 0x7e;
const FirstPrintable = 0x20;
const CarriageReturn = 0x0d;
const Unprintable = "?".charCodeAt(0);
const LastStreamId = 0xff;

/** Thrown inside a call that a break has overtaken, which has no one left to answer. */
export class Superseded extends Error {}

/** What the ROM is to do once a call has been made, as the bytes it reads from the stream. */
export class Response {
    constructor() {
        this.bytes = [];
        this.ended = false;
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
function errorBytes({ number, message }) {
    const response = new Response();
    response.error(number, message);
    return response.bytes;
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
        this._streams = new Map();
        this._nextStream = 1;
        this._responseStream = 0;
        this._selectedStream = 0;
        this._busy = false;
        this._epoch = 0;
    }

    /** How many responses the ROM has not finished reading. */
    get openStreams() {
        return this._streams.size;
    }

    /** Ends a call that is waiting with an error, for when what it was waiting for is not there any more. */
    abort(error) {
        if (!this._busy) return;
        this._epoch++;
        this._answerWith(errorBytes(error), null);
    }

    /** What the device holds between one of the ROM's reads and the next, for a snapshot to restore the ROM mid-call. */
    snapshotState() {
        return {
            inputs: { ...this._inputs },
            nextStream: this._nextStream,
            responseStream: this._responseStream,
            selectedStream: this._selectedStream,
            busy: this._busy,
            streams: [...this._streams].map(([id, { bytes, position, results }]) => [
                id,
                [...bytes],
                position,
                results && { ...results },
            ]),
        };
    }

    /** A call that was waiting is answered with "Disc changed". What a snapshot file has wrong is left out or made a byte. */
    restoreState(state) {
        this.reset();
        const inputs = state?.inputs ?? {};
        this._inputs = { a: byte(inputs.a), x: byte(inputs.x), y: byte(inputs.y) };
        this._nextStream = byte(state?.nextStream) || 1;
        this._responseStream = byte(state?.responseStream);
        this._selectedStream = byte(state?.selectedStream);
        for (const entry of Array.isArray(state?.streams) ? state.streams : []) {
            const [id, bytes, position, results] = Array.isArray(entry) ? entry : [];
            if (!Array.isArray(bytes) || !Number.isInteger(position)) continue;
            const kept = results && {
                a: byte(results.a),
                x: byte(results.x),
                y: byte(results.y),
                carry: results.carry ? 1 : 0,
            };
            this._streams.set(byte(id), { bytes: bytes.map(byte), position, results: kept ?? null });
        }
        if (state?.busy) this._answerWith(errorBytes(Errors.discChanged()), null);
    }

    /** A break: a call under way has no one to answer, and no response is left unread. */
    reset() {
        this._epoch++;
        this._busy = false;
        this._inputs = { a: 0, x: 0, y: 0 };
        this._streams.clear();
    }

    read(offset) {
        switch (offset) {
            case Port.go:
                return this._status();
            case Port.aRes:
                return this._takeResult("a");
            case Port.xRes:
                return this._streams.get(this._selectedStream)?.results?.x ?? 0;
            case Port.yRes:
                return this._streams.get(this._selectedStream)?.results?.y ?? 0;
            case Port.stream:
                return this._responseStream;
            case Port.data:
                return this._nextByte();
            case Port.id:
                return HostId;
            default:
                return 0;
        }
    }

    write(offset, value) {
        switch (offset) {
            case Port.go:
                this._call(value);
                break;
            case Port.aIn:
                this._inputs.a = value;
                break;
            case Port.xIn:
                this._inputs.x = value;
                break;
            case Port.yIn:
                this._inputs.y = value;
                break;
            case Port.stream:
                this._selectedStream = value;
                break;
        }
    }

    _status() {
        if (this._busy) return Busy;
        const answer = this._streams.get(this._responseStream);
        const selected = this._streams.get(this._selectedStream);
        const waiting = answer && answer.position < answer.bytes.length;
        return (waiting ? OpsWaiting : 0) | (selected?.results?.carry ? CarryOut : 0);
    }

    /** The A the call returns, which is the last thing the ROM reads of a response, and so frees it. */
    _takeResult(register) {
        const stream = this._streams.get(this._selectedStream);
        if (!stream?.results) return 0;
        const value = stream.results[register];
        this._streams.delete(this._selectedStream);
        return value;
    }

    /** A stream that is not there was cut off by a break or a restored snapshot, and what reads it is told the disc changed. */
    _nextByte() {
        let stream = this._streams.get(this._selectedStream);
        if (!stream) {
            stream = { bytes: errorBytes(Errors.discChanged()), position: 0, results: null };
            this._streams.set(this._selectedStream, stream);
        }
        const byte = stream.bytes[stream.position++];
        if (stream.position >= stream.bytes.length && !stream.results) this._streams.delete(this._selectedStream);
        return byte ?? 0;
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
            if (response.ended) return this._answerWith(response.bytes, null);
            const results = {
                a: byte(registers.a),
                x: byte(registers.x),
                y: byte(registers.y),
                carry: registers.p & 1,
            };
            if (response.bytes.length > 0) response.bytes.push(Op.done);
            this._answerWith(response.bytes, results);
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

    /** Makes `bytes` and `results` the answer the ROM reads next. */
    _answerWith(bytes, results) {
        this._responseStream = this._newStream(bytes, results);
        this._selectedStream = this._responseStream;
        this._busy = false;
    }

    /** A number not in use by a response still being read; if all are, the one that would come next is replaced. */
    _newStream(bytes, results) {
        const after = (id) => (id === LastStreamId ? 1 : id + 1);
        let id = this._nextStream;
        for (let tried = 0; this._streams.has(id) && tried < LastStreamId; tried++) id = after(id);
        this._nextStream = after(id);
        this._streams.set(id, { bytes, position: 0, results });
        return id;
    }
}
