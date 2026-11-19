import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VdfsError } from "../../src/vdfs-errors.js";
import {
    Busy,
    Call,
    CarryOut,
    HostId,
    IdMask,
    Op,
    Port,
    PortBase,
    PortBytes,
    Superseded,
    VdfsPorts,
} from "../../src/vdfs-protocol.js";
import { RepoRoot } from "../integration/helpers.js";
import { readResponse } from "../helpers/vdfs-response.js";

const upperFirst = (name) => name[0].toUpperCase() + name.slice(1);

/** Ports whose calls print what `says` gives for the call's number. */
const portsSaying = (says) => new VdfsPorts((call, registers, response) => response.print(says(call)));

function makeCall(ports, call, registers = {}) {
    for (const [port, value] of Object.entries({ a: 0, x: 0, y: 0, ...registers })) ports.write(Port[port], value);
    ports.write(Port.go, call);
}

/** A promise, and the way to settle it, to stand for a store that takes its time. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

describe("VDFS protocol", () => {
    describe("the contract with the ROM", () => {
        const source = readFileSync(path.join(RepoRoot, "roms-src/vdfs/contract.6502"), "utf8");
        const defined = {};
        for (const [, name, expression] of source.matchAll(/^(\w+)\s*=\s*(.+)$/gm)) {
            const substituted = expression
                .replace(/&([0-9A-F]+)/g, "0x$1")
                .replace(/[A-Za-z]\w*/g, (symbol) => defined[symbol] ?? symbol);
            defined[name] = Function(`return (${substituted})`)();
        }

        it("gives the ports, calls and ops the same numbers as the ROM's source", () => {
            const prefixed = (prefix, table) =>
                Object.fromEntries(
                    Object.entries(table).map(([name, value]) => [`${prefix}${upperFirst(name)}`, value]),
                );
            expect(defined).toEqual({
                PortBase,
                ...Object.fromEntries(
                    Object.entries(Port).map(([name, offset]) => [`Port${upperFirst(name)}`, PortBase + offset]),
                ),
                HostId,
                IdMask,
                CarryBit: CarryOut,
                ...prefixed("Call", Call),
                ...prefixed("Op", Op),
            });
        });

        it("puts the status where the ROM tests it: busy in the top bit, which BIT copies, then the carry, then the ID", () => {
            expect([Busy, CarryOut, IdMask]).toEqual([0x80, 0x40, 0x3f]);
            expect(HostId & ~IdMask).toBe(0);
        });

        it("takes the four bytes of FRED from the start of the window for them", () => {
            expect(PortBase).toBe(0xfc60);
            expect(Object.values(Port).sort()).toEqual([...Array(PortBytes).keys()]);
        });
    });

    describe("responses", () => {
        it("tells a ROM that has a host to talk to by the bottom bits of the status, whatever else it says", () => {
            const ports = new VdfsPorts((call, registers) => {
                registers.p = 1;
            });
            expect(ports.read(Port.go) & IdMask).toBe(HostId);
            makeCall(ports, Call.file);
            expect(ports.read(Port.go) & IdMask).toBe(HostId);
            const slow = new VdfsPorts(() => new Promise(() => {}));
            makeCall(slow, Call.file);
            expect(slow.read(Port.go) & IdMask).toBe(HostId);
        });

        it("gives the registers a call was made with, and returns the ones it ended with and the carry", () => {
            const ports = new VdfsPorts((call, registers) => {
                registers.a = registers.x + registers.y;
                registers.p |= 1;
            });
            makeCall(ports, Call.file, { x: 2, y: 3 });
            expect(readResponse(ports, {})).toEqual({ ops: [], a: 5, x: 2, y: 3, p: 1 });
        });

        it("keeps each response's own registers, so a call made while its ops are being read does not change them", () => {
            const ports = new VdfsPorts((call, registers, response) => {
                registers.a = call === Call.file ? 0x11 : 0x22;
                registers.x = call === Call.file ? 0x33 : 0x44;
                registers.p = call === Call.file ? 1 : 0;
                response.print(call === Call.file ? "AB" : "X");
            });
            makeCall(ports, Call.file);
            for (let read = 0; read < 2; read++) ports.read(Port.a);
            makeCall(ports, Call.args);
            expect(readResponse(ports, {})).toMatchObject({ a: 0x22, x: 0x44, p: 0 });
            for (let read = 0; read < 3; read++) ports.read(Port.a);
            expect([ports.read(Port.x), ports.read(Port.go) & CarryOut, ports.read(Port.a)]).toEqual([
                0x33,
                CarryOut,
                0x11,
            ]);
            expect(ports.openResponses).toBe(0);
        });

        it("shows a control code as a question mark, a NUL too since the ROM takes it for the end, but not a return", () => {
            const ports = portsSaying(() => "a\u0000b\u001bc\u0016d\re");
            makeCall(ports, Call.file);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "a?b?c?d\re" }]);
        });

        it("shows what the BBC cannot print as a question mark, and not as another character", () => {
            const ports = portsSaying(() => "tést");
            makeCall(ports, Call.file);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "t?st" }]);
        });

        it("keeps each call's response apart, so a call made while one is being read leaves it whole", () => {
            const ports = portsSaying((call) => (call === Call.file ? "AB" : "XY"));
            makeCall(ports, Call.file);
            expect(ports.read(Port.a)).toBe(Op.print);
            expect(ports.read(Port.a)).toBe("A".charCodeAt(0));
            makeCall(ports, Call.args);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "XY" }]);
            expect(ports.read(Port.a)).toBe("B".charCodeAt(0));
        });

        describe("what a call that goes wrong says", () => {
            beforeEach(() => {
                vi.spyOn(console, "error").mockImplementation(() => {});
            });

            afterEach(() => {
                vi.restoreAllMocks();
            });

            it("is the OS's error for what is wrong with the call, and one that says so for a bug", () => {
                const ports = new VdfsPorts((call) => {
                    throw call === Call.file ? new VdfsError(0xd6, "Not found") : new TypeError("x".repeat(500));
                });
                makeCall(ports, Call.file);
                expect(readResponse(ports, {}).ops).toEqual([{ op: "error", number: 0xd6, text: "Not found" }]);
                makeCall(ports, Call.args);
                const [{ number, text }] = readResponse(ports, {}).ops;
                expect(number).toBe(0xff);
                expect(text).toMatch(/^VDFS host failure: x/);
                expect(text.length).toBe(80);
            });

            it("is the same when the call is one that took its time", async () => {
                const waiting = deferred();
                const ports = new VdfsPorts(() => waiting.promise);
                makeCall(ports, Call.file);
                waiting.reject(new VdfsError(0xc3, "Locked"));
                await waiting.promise.catch(() => {});
                await Promise.resolve();
                expect(readResponse(ports, {}).ops).toEqual([{ op: "error", number: 0xc3, text: "Locked" }]);
            });
        });
    });

    describe("a call that takes its time", () => {
        it("is busy until it is done, and then is answered as one that was done at once", async () => {
            const waiting = deferred();
            const ports = new VdfsPorts((call, registers) => {
                registers.a = 7;
                return waiting.promise;
            });
            expect(ports.read(Port.go) & Busy).toBe(0);
            makeCall(ports, Call.file);
            expect(ports.read(Port.go) & Busy).toBe(Busy);
            waiting.resolve();
            await waiting.promise;
            await Promise.resolve();
            expect(ports.read(Port.go) & Busy).toBe(0);
            expect(readResponse(ports, {}).a).toBe(7);
        });

        it("ends a call with an error when a call made meanwhile, as from an interrupt, was answered and read first", async () => {
            const waiting = deferred();
            const ports = new VdfsPorts((call) => (call === Call.file ? waiting.promise : undefined));
            makeCall(ports, Call.file);
            makeCall(ports, Call.args);
            readResponse(ports, {});
            waiting.resolve();
            await waiting.promise;
            await Promise.resolve();
            expect(ports.read(Port.go) & Busy).toBe(0);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "error", number: 0xc9, text: "Disc changed" }]);
        });

        it("ends a waiting call with an error when the call that interrupts it also takes its time", async () => {
            const outer = deferred();
            const inner = deferred();
            const ports = new VdfsPorts((call) => (call === Call.file ? outer.promise : inner.promise));
            makeCall(ports, Call.file);
            makeCall(ports, Call.args);
            inner.resolve();
            await inner.promise;
            await Promise.resolve();
            expect(readResponse(ports, {}).ops).toEqual([]);
            outer.resolve();
            await outer.promise;
            await Promise.resolve();
            expect(readResponse(ports, {}).ops).toEqual([{ op: "error", number: 0xc9, text: "Disc changed" }]);
        });

        it("is not answered at all if a break comes first, and a call made after it is", async () => {
            const waiting = deferred();
            const ports = new VdfsPorts((call, registers, response, turn) =>
                call === Call.file ? waiting.promise.then(() => turn.check()) : response.print("NEW"),
            );
            makeCall(ports, Call.file);
            ports.reset();
            expect(ports.read(Port.go) & Busy).toBe(0);
            makeCall(ports, Call.args);
            waiting.resolve();
            await waiting.promise;
            await Promise.resolve();
            expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "NEW" }]);
        });

        it("ends a call that is waiting with an error, which a later answer does not replace", async () => {
            const waiting = deferred();
            const ports = new VdfsPorts(() => waiting.promise);
            makeCall(ports, Call.file);
            ports.abort(new VdfsError(0xc9, "Disc changed"));
            expect(ports.read(Port.go) & Busy).toBe(0);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "error", number: 0xc9, text: "Disc changed" }]);
            waiting.resolve();
            await waiting.promise;
            await Promise.resolve();
            expect(ports.openResponses).toBe(0);
        });

        it("has nothing to end when no call is waiting", () => {
            const ports = portsSaying(() => "A");
            ports.abort(new VdfsError(0xc9, "Disc changed"));
            expect(ports.openResponses).toBe(0);
        });

        it("tells the call that a break has overtaken it, so that it does not go on to change the machine", async () => {
            const waiting = deferred();
            let seen;
            const ports = new VdfsPorts((call, registers, response, turn) => {
                seen = turn;
                return waiting.promise;
            });
            makeCall(ports, Call.file);
            expect(() => seen.check()).not.toThrow();
            ports.reset();
            expect(seen.current).toBe(false);
            expect(() => seen.check()).toThrow(Superseded);
        });
    });

    describe("what is left of a response", () => {
        const discChanged = (ports) => {
            const bytes = [];
            for (let byte = ports.read(Port.a); bytes.length < 3 || byte !== 0; byte = ports.read(Port.a))
                bytes.push(byte);
            expect(bytes[0]).toBe(Op.error);
            expect(bytes[1]).toBe(0xc9);
            expect(String.fromCharCode(...bytes.slice(2))).toBe("Disc changed");
        };

        it("keeps nothing of one that has been read to its end", () => {
            const ports = portsSaying(() => "A");
            makeCall(ports, Call.file);
            readResponse(ports, {});
            expect(ports.openResponses).toBe(0);
        });

        it("hands the ROM an exec address of zero as zero, though its RTS takes one less", () => {
            const ports = new VdfsPorts((call, registers, response) => response.exec(0));
            makeCall(ports, Call.file);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "exec", address: 0 }]);
        });

        it.each([
            ["an exec", (response) => response.exec(0x1900)],
            ["an error", (response) => response.error(1, "x")],
        ])("has no return registers after %s, which the ROM does not come back to read", (_, end) => {
            const ports = new VdfsPorts((call, registers, response) => end(response));
            makeCall(ports, Call.file);
            readResponse(ports, {});
            expect(ports.openResponses).toBe(0);
        });

        it("drops what is below an error once it is read, since the BRK it raises never returns to it", () => {
            const ports = new VdfsPorts((call, registers, response) =>
                call === Call.file ? response.print("AB") : response.error(1, "x"),
            );
            makeCall(ports, Call.file);
            ports.read(Port.a);
            makeCall(ports, Call.args);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "error", number: 1, text: "x" }]);
            expect(ports.openResponses).toBe(0);
        });

        it("keeps nothing across a break", () => {
            const ports = portsSaying(() => "A");
            makeCall(ports, Call.file);
            expect(ports.openResponses).toBe(1);
            ports.reset();
            expect(ports.openResponses).toBe(0);
        });

        it("tells what reads a response that a break took, or that an interrupt's call finished, that the disc changed", () => {
            const ports = portsSaying(() => "AB");
            makeCall(ports, Call.file);
            ports.read(Port.a);
            ports.reset();
            discChanged(ports);
            expect(ports.openResponses).toBe(0);
        });

        it("can be put back from a snapshot partway through reading a response, and ends a call that was waiting", () => {
            const ports = portsSaying(() => "AB");
            makeCall(ports, Call.file);
            ports.read(Port.a);
            ports.read(Port.a);
            const state = JSON.parse(JSON.stringify(ports.snapshotState()));
            const restored = portsSaying(() => "ZZ");
            restored.restoreState(state);
            expect([restored.read(Port.a), restored.read(Port.a), restored.read(Port.a)]).toEqual([
                "B".charCodeAt(0),
                0,
                Op.done,
            ]);

            const slow = new VdfsPorts(() => new Promise(() => {}));
            makeCall(slow, Call.file);
            expect(slow.read(Port.go) & Busy).toBe(Busy);
            const waiting = portsSaying(() => "ZZ");
            waiting.restoreState(JSON.parse(JSON.stringify(slow.snapshotState())));
            expect(waiting.read(Port.go) & Busy).toBe(0);
            expect(waiting.read(Port.a)).toBe(Op.error);
        });

        it.each([
            ["nothing at all", undefined],
            ["no responses", { responses: "none", inputs: null }],
            ["numbers that are not bytes", { inputs: { a: 300, x: -1, y: "q" } }],
            ["a response with no bytes", { responses: [["AB", 0], null, [[1, 2], 0.5]] }],
        ])("puts back what it can of a snapshot that is %s, and does not throw", (_, state) => {
            const ports = portsSaying(() => "A");
            expect(() => ports.restoreState(state)).not.toThrow();
            expect(ports.openResponses).toBe(0);
            makeCall(ports, Call.file);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "A" }]);
        });

        it("keeps no more of a snapshot's responses than it would hold, with their positions inside them", () => {
            const ports = portsSaying(() => "A");
            ports.restoreState({ responses: Array.from({ length: 100 }, () => [[1, 2], -5, null]) });
            expect(ports.openResponses).toBeLessThan(100);
            expect(ports.read(Port.a)).toBe(1);
        });

        it("masks the numbers in a snapshot to bytes", () => {
            const ports = portsSaying(() => "A");
            ports.restoreState({ responses: [[[256, 3], 0, { x: 258, y: 259, carry: 1 }]] });
            expect([ports.read(Port.x), ports.read(Port.y), ports.read(Port.go) & CarryOut]).toEqual([2, 3, CarryOut]);
            expect([ports.read(Port.a), ports.read(Port.a)]).toEqual([0, 3]);
        });

        it("drops the oldest of the responses a ROM never finished reading, rather than keep them for ever", () => {
            const ports = portsSaying(() => "A");
            for (let call = 0; call < 600; call++) makeCall(ports, Call.file);
            expect(ports.openResponses).toBeLessThan(600);
            expect(ports.openResponses).toBeGreaterThan(1);
        });
    });
});
