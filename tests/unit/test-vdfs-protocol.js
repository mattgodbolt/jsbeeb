import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VdfsError } from "../../src/vdfs-errors.js";
import { Busy, Call, HostId, Op, Port, PortBase, Superseded, VdfsPorts } from "../../src/vdfs-protocol.js";
import { RepoRoot } from "../integration/helpers.js";
import { readResponse } from "../helpers/vdfs.js";

const upperFirst = (name) => name[0].toUpperCase() + name.slice(1);

/** Ports whose calls print what `says` gives for the call's number. */
const portsSaying = (says) => new VdfsPorts((call, registers, response) => response.print(says(call)));

function makeCall(ports, call, registers = {}) {
    for (const [port, value] of Object.entries({ a: 0, x: 0, y: 0, p: 0, ...registers }))
        ports.write(Port[port], value);
    ports.write(Port.call, call);
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
                ...prefixed("Call", Call),
                ...prefixed("Op", Op),
            });
        });

        it("makes the busy flag the one the ROM tests with BIT, which is the top bit", () => {
            expect(Busy).toBe(0x80);
        });
    });

    describe("responses", () => {
        it("tells a ROM that has a host to talk to by the byte at the ID port", () => {
            expect(portsSaying(() => "").read(Port.id)).toBe(HostId);
        });

        it("gives the registers a call was made with, and returns the ones it ended with", () => {
            const ports = new VdfsPorts((call, registers) => {
                registers.a = registers.x + registers.y;
            });
            makeCall(ports, Call.file, { x: 2, y: 3, p: 0x31 });
            expect(readResponse(ports, {})).toEqual({ ops: [], a: 5, x: 2, y: 3, p: 0x31 });
        });

        it("shows what the BBC cannot print as a question mark, and not as another character", () => {
            const ports = portsSaying(() => "tést");
            makeCall(ports, Call.file);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "t?st" }]);
        });

        it("keeps each call's response apart, so a call made while one is being read leaves it whole", () => {
            const ports = portsSaying((call) => (call === Call.file ? "AB" : "XY"));
            makeCall(ports, Call.file);
            const outer = ports.read(Port.stream);
            ports.write(Port.stream, outer);
            expect(ports.read(Port.data)).toBe(Op.print);
            expect(ports.read(Port.data)).toBe("A".charCodeAt(0));
            makeCall(ports, Call.args);
            const inner = ports.read(Port.stream);
            expect(inner).not.toBe(outer);
            ports.write(Port.stream, outer);
            expect(ports.read(Port.data)).toBe("B".charCodeAt(0));
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
            expect(ports.read(Port.call)).toBe(0);
            makeCall(ports, Call.file);
            expect(ports.read(Port.call)).toBe(Busy);
            waiting.resolve();
            await waiting.promise;
            await Promise.resolve();
            expect(ports.read(Port.call)).toBe(0);
            expect(readResponse(ports, {}).a).toBe(7);
        });

        it("is not answered at all if a break comes first, and a call made after it is", async () => {
            const waiting = deferred();
            const ports = new VdfsPorts((call, registers, response, turn) =>
                call === Call.file ? waiting.promise.then(() => turn.check()) : response.print("NEW"),
            );
            makeCall(ports, Call.file);
            ports.reset();
            expect(ports.read(Port.call)).toBe(0);
            makeCall(ports, Call.args);
            const answered = ports.read(Port.stream);
            waiting.resolve();
            await waiting.promise;
            await Promise.resolve();
            expect(ports.read(Port.stream)).toBe(answered);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "NEW" }]);
        });

        it("ends a call that is waiting with an error, which a later answer does not replace", async () => {
            const waiting = deferred();
            const ports = new VdfsPorts(() => waiting.promise);
            makeCall(ports, Call.file);
            ports.abort(new VdfsError(0xc9, "Disc changed"));
            expect(ports.read(Port.call)).toBe(0);
            expect(readResponse(ports, {}).ops).toEqual([{ op: "error", number: 0xc9, text: "Disc changed" }]);
            waiting.resolve();
            await waiting.promise;
            await Promise.resolve();
            expect(ports.openStreams).toBe(0);
        });

        it("has nothing to end when no call is waiting", () => {
            const ports = portsSaying(() => "A");
            ports.abort(new VdfsError(0xc9, "Disc changed"));
            expect(ports.openStreams).toBe(0);
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
        it("keeps nothing of one that has been read to its end", () => {
            const ports = portsSaying(() => "A");
            makeCall(ports, Call.file);
            readResponse(ports, {});
            expect(ports.openStreams).toBe(0);
        });

        it.each([
            ["an exec", (response) => response.exec(0x1900)],
            ["an error", (response) => response.error(1, "x")],
        ])("has no return registers after %s, which the ROM does not come back to read", (_, end) => {
            const ports = new VdfsPorts((call, registers, response) => end(response));
            makeCall(ports, Call.file);
            const stream = ports.read(Port.stream);
            readResponse(ports, {});
            ports.write(Port.stream, stream);
            expect(ports.openStreams).toBe(0);
        });

        it("keeps nothing across a break", () => {
            const ports = portsSaying(() => "A");
            makeCall(ports, Call.file);
            expect(ports.openStreams).toBe(1);
            ports.reset();
            expect(ports.openStreams).toBe(0);
        });

        it("does not give a call's response the number of one that is being read, however many calls come between", () => {
            const ports = portsSaying((call) => (call === Call.file ? "AB" : "X"));
            makeCall(ports, Call.file);
            const outer = ports.read(Port.stream);
            const readOuter = () => {
                ports.write(Port.stream, outer);
                return ports.read(Port.data);
            };
            expect(readOuter()).toBe(Op.print);
            expect(readOuter()).toBe("A".charCodeAt(0));
            for (let nested = 0; nested < 600; nested++) {
                makeCall(ports, Call.bput);
                expect(readResponse(ports, {}).ops).toEqual([{ op: "print", text: "X" }]);
            }
            expect(readOuter()).toBe("B".charCodeAt(0));
            expect(readOuter()).toBe(0);
            expect(readOuter()).toBe(Op.done);
        });

        it("tells what reads a response that a break took that the disc changed", () => {
            const ports = portsSaying(() => "AB");
            makeCall(ports, Call.file);
            const stream = ports.read(Port.stream);
            ports.write(Port.stream, stream);
            ports.read(Port.data);
            ports.reset();
            ports.write(Port.stream, stream);
            const bytes = [];
            for (let byte = ports.read(Port.data); bytes.length < 3 || byte !== 0; byte = ports.read(Port.data))
                bytes.push(byte);
            expect(bytes[0]).toBe(Op.error);
            expect(bytes[1]).toBe(0xc9);
            expect(String.fromCharCode(...bytes.slice(2))).toBe("Disc changed");
        });

        it("goes round the 255 numbers it has for responses, so one that is never read is replaced", () => {
            const ports = portsSaying(() => "A");
            const seen = new Set();
            for (let call = 0; call < 600; call++) {
                makeCall(ports, Call.file);
                seen.add(ports.read(Port.stream));
            }
            expect(seen.size).toBe(255);
            expect(seen.has(0)).toBe(false);
            expect(ports.openStreams).toBe(255);
        });
    });
});
