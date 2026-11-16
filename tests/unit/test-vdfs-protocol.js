import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { VdfsError } from "../../src/vdfs-errors.js";
import { Call, HostId, Op, Port, PortBase, VdfsPorts } from "../../src/vdfs-protocol.js";
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

        it("raises what a call says is wrong as the OS's error, and what is a bug as one that says so", () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
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
            vi.restoreAllMocks();
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
