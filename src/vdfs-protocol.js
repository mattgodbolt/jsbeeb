// The device the VDFS ROM in roms-src/vdfs talks to: eight ports in FRED that the ROM writes a call's registers and
// number to, waits on while the host does the call, and then reads a stream of ops for it to carry out. See
// docs/vdfs.md.

import { VdfsError } from "./vdfs-errors.js";

export const PortBase = 0xfc60;
export const Port = Object.freeze({ call: 0, a: 1, x: 2, y: 3, p: 4, stream: 5, data: 6, id: 7 });
export const HostId = 0x56;
export const VdfsRom = "vdfs.rom";
/** What a read of the call port gives while the host is still doing the call. */
export const Busy = 0x80;

export const Call = Object.freeze({ service: 0, file: 1, args: 2, bget: 3, bput: 4, gbpb: 5, find: 6, fsc: 7 });
export const Op = Object.freeze({ done: 0, print: 1, error: 2, exec: 3, claim: 4 });

const RegisterOfPort = Object.freeze({ [Port.a]: "a", [Port.x]: "x", [Port.y]: "y", [Port.p]: "p" });
const MaxErrorText = 80;
const HostFailureNumber = 0xff;
const LastAscii = 0x7e;
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
        for (const char of text) this.bytes.push(char.charCodeAt(0) <= LastAscii ? char.charCodeAt(0) : Unprintable);
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

    /** Ends the response with the registers to return, unless the ROM is not to come back for them. */
    done({ a, x, y, p }) {
        if (this.ended) return;
        this.bytes.push(Op.done, x & 0xff, y & 0xff, p & 0xff, a & 0xff);
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

export class VdfsPorts {
    /**
     * @param {(call: number, registers: {a: number, x: number, y: number, p: number}, response: Response, turn: Turn) => void | Promise<void>} dispatch
     *   does a call, and may take its time over it: the ROM waits
     */
    constructor(dispatch) {
        this._dispatch = dispatch;
        this._request = { a: 0, x: 0, y: 0, p: 0 };
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
        const response = new Response();
        response.error(error.number, error.message);
        this._responseStream = this._newStream(response.bytes);
        this._busy = false;
    }

    /** A break: a call under way has no one to answer, and no response is left unread. */
    reset() {
        this._epoch++;
        this._busy = false;
        this._streams.clear();
    }

    read(offset) {
        switch (offset) {
            case Port.call:
                return this._busy ? Busy : 0;
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
            case Port.call:
                this._call(value);
                break;
            case Port.a:
            case Port.x:
            case Port.y:
            case Port.p:
                this._request[RegisterOfPort[offset]] = value;
                break;
            case Port.stream:
                this._selectedStream = value;
                break;
        }
    }

    _nextByte() {
        const stream = this._streams.get(this._selectedStream);
        if (!stream) return 0;
        const byte = stream.bytes[stream.position++];
        if (stream.position >= stream.bytes.length) this._streams.delete(this._selectedStream);
        return byte ?? 0;
    }

    /**
     * Starts a call. A call that finishes at once is answered at once; one that does not leaves the call port busy
     * until it has. A call that fails is answered with an error, one that is a bug in the host with one that says so.
     */
    _call(call) {
        const turn = new Turn(this, ++this._epoch);
        const registers = { ...this._request };
        const response = new Response();
        this._busy = true;
        const answer = (error) => {
            if (!turn.current) return;
            if (error === undefined) response.done(registers);
            else if (error instanceof VdfsError) response.error(error.number, error.message);
            else {
                console.error("VDFS host failure:", error);
                response.error(HostFailureNumber, `VDFS host failure: ${error.message}`);
            }
            this._responseStream = this._newStream(response.bytes);
            this._busy = false;
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

    _newStream(bytes) {
        const id = this._nextStream;
        this._nextStream = id === LastStreamId ? 1 : id + 1;
        this._streams.set(id, { bytes, position: 0 });
        return id;
    }
}
