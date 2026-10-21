// Everything the shell bundle (tools/shell-bench.js) needs from V8's d8, SpiderMonkey's js and JavaScriptCore's
// jsc, which have neither Node's modules nor the browser's globals. The differences between the shells end here.
const Base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BitsPerBase64Digit = 6;
const BitsPerByte = 8;
const ByteMask = 0xff;
const CharCodeChunk = 0x8000;
const MsPerSecond = 1000;

const readBytes = globalThis.readbuffer
    ? (file) => new Uint8Array(globalThis.readbuffer(file))
    : globalThis.os?.file
      ? (file) => globalThis.os.file.readFile(file, "binary")
      : (file) => globalThis.readFile(file, "binary");

function bytesToLatin1(bytes) {
    const chunks = [];
    for (let start = 0; start < bytes.length; start += CharCodeChunk) {
        chunks.push(String.fromCharCode(...bytes.subarray(start, start + CharCodeChunk)));
    }
    return chunks.join("");
}

export function atob(base64) {
    const out = [];
    let bits = 0;
    let bitCount = 0;
    for (const digit of base64.replace(/[=\s]/g, "")) {
        bits = (bits << BitsPerBase64Digit) | Base64Digits.indexOf(digit);
        bitCount += BitsPerBase64Digit;
        if (bitCount >= BitsPerByte) {
            bitCount -= BitsPerByte;
            out.push(String.fromCharCode((bits >> bitCount) & ByteMask));
        }
    }
    return out.join("");
}

export class Event {
    constructor(type) {
        this.type = type;
    }
}

export class CustomEvent extends Event {
    constructor(type, { detail = null } = {}) {
        super(type);
        this.detail = detail;
    }
}

export class EventTarget {
    #listeners = new Map();

    addEventListener(type, listener) {
        if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
        this.#listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
        this.#listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event) {
        for (const listener of this.#listeners.get(event.type) ?? []) listener.call(this, event);
        return true;
    }
}

export class Utf8Decoder {
    decode(bytes) {
        return decodeURIComponent(escape(bytesToLatin1(bytes)));
    }
}

// jsc's performance.now() ticks in 20 microseconds, a few percent of a slice; preciseTime() is in seconds.
if (globalThis.preciseTime) globalThis.performance.now = () => globalThis.preciseTime() * MsPerSecond;
globalThis.Event ??= Event;
globalThis.CustomEvent ??= CustomEvent;
globalThis.EventTarget ??= EventTarget;
globalThis.console ??= { log: globalThis.print, warn: globalThis.print, error: globalThis.print };
globalThis.atob ??= atob;
globalThis.TextDecoder ??= Utf8Decoder;

// Every path the bundle reads is absolute, so these need no working directory.
function normalise(file) {
    const parts = [];
    for (const part of file.split("/")) {
        if (part === "..") parts.pop();
        else if (part && part !== ".") parts.push(part);
    }
    return `/${parts.join("/")}`;
}

/** Stand-ins for the parts of Node's modules that the benchmark machine's code reaches. */
export const fs = {
    readFileSync: readBytes,
    existsSync(file) {
        try {
            readBytes(file);
            return true;
        } catch {
            return false;
        }
    },
};
export const path = {
    join: (...parts) => normalise(parts.join("/")),
    resolve: (...parts) => normalise(parts.join("/")),
    dirname: (file) => normalise(`${file}/..`),
};
export const url = { fileURLToPath: (fileUrl) => decodeURIComponent(fileUrl.replace(/^file:\/\//, "")) };
export const util = { inspect: String };
export function assert(condition, message) {
    if (!condition) throw new Error(message ?? "Assertion failed");
}

/**
 * Runs `measure` on the options the runner passes as the script's last argument, as JSON, and prints its
 * result as the last line of output.
 * @param {function(object): Promise<object>} measure
 */
export function runSample(measure) {
    const args = globalThis.scriptArgs ?? globalThis.arguments;
    measure(JSON.parse(args.at(-1))).then(
        (result) => globalThis.print(JSON.stringify({ result })),
        (error) => {
            globalThis.print(JSON.stringify({ error: error.stack ? `${error}\n${error.stack}` : String(error) }));
            globalThis.quit(1);
        },
    );
}
