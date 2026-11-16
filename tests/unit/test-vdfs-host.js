import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Call, FilingSystemNumber, FirstHandle, HostId, LastHandle, Op, Port, PortBase } from "../../src/vdfs-host.js";
import { RepoRoot } from "../integration/helpers.js";
import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import { directory, file, getLong, hostWith, putLong, putString, text } from "../helpers/vdfs.js";

const Carry = 0x01;
const Block = 0x2000;
const Name = 0x2100;
const Data = 0x3000;

/** Fills an OSFILE block for `name`. */
function fileBlock(cpu, name, { load = 0, exec = 0, start = 0, end = 0 } = {}) {
    putString(cpu, Name, name);
    cpu.memory[Block] = Name & 0xff;
    cpu.memory[Block + 1] = Name >> 8;
    putLong(cpu, Block + 2, load);
    putLong(cpu, Block + 6, exec);
    putLong(cpu, Block + 10, start);
    putLong(cpu, Block + 14, end);
}

const osfile = (t, action) => t.call(Call.file, { a: action, x: Block & 0xff, y: Block >> 8 });
const errorOf = (result) => result.ops.find((op) => op.op === "error");

async function open(t, name, mode) {
    putString(t.cpu, Name, name);
    return (await t.call(Call.find, { a: mode, x: Name & 0xff, y: Name >> 8 })).a;
}

describe("VDFS host", () => {
    describe("the contract with the ROM", () => {
        const source = readFileSync(path.join(RepoRoot, "roms-src/vdfs/contract.6502"), "utf8");
        const defined = {};
        for (const [, name, expression] of source.matchAll(/^(\w+)\s*=\s*(.+)$/gm)) {
            defined[name] = expression
                .replace(/&([0-9A-F]+)/g, "0x$1")
                .replace(/[A-Za-z]\w*/g, (symbol) => defined[symbol] ?? symbol);
            defined[name] = Function(`return (${defined[name]})`)();
        }

        it("gives the ports, calls and ops the same numbers as the ROM's source", () => {
            const expected = {
                PortBase,
                PortCall: PortBase + Port.call,
                PortA: PortBase + Port.a,
                PortX: PortBase + Port.x,
                PortY: PortBase + Port.y,
                PortP: PortBase + Port.p,
                PortStream: PortBase + Port.stream,
                PortData: PortBase + Port.data,
                PortId: PortBase + Port.id,
                HostId,
                ...Object.fromEntries(
                    Object.entries(Call).map(([name, value]) => [
                        `Call${name[0].toUpperCase()}${name.slice(1)}`,
                        value,
                    ]),
                ),
                ...Object.fromEntries(
                    Object.entries(Op).map(([name, value]) => [`Op${name[0].toUpperCase()}${name.slice(1)}`, value]),
                ),
            };
            expect(defined).toEqual(expected);
        });
    });

    describe("streams", () => {
        it("keeps each call's response apart, so a call made while one is being read leaves it whole", async () => {
            const t = await hostWith([file("A", "x")]);
            t.call(Call.args, { a: 0, y: 0 });
            t.host.write(Port.a, 0);
            t.host.write(Port.y, 0);
            t.host.write(Port.call, Call.args);
            const outer = t.host.read(Port.stream);
            t.host.write(Port.stream, outer);
            expect(t.host.read(Port.data)).toBe(Op.done);
            t.host.write(Port.call, Call.args);
            const inner = t.host.read(Port.stream);
            expect(inner).not.toBe(outer);
            t.host.write(Port.stream, outer);
            expect(t.host.read(Port.data)).toBe(0);
        });

        it("answers a read of the ID port so the ROM knows the host is there", async () => {
            const t = await hostWith();
            expect(t.host.read(Port.id)).toBe(HostId);
        });
    });

    describe("OSFILE", () => {
        it("saves the bytes in memory as a file, with its addresses, and writes it to the store", async () => {
            const t = await hostWith();
            t.cpu.memory.set(new TextEncoder().encode("HELLO"), Data);
            fileBlock(t.cpu, "GREET", { load: 0xffff1900, exec: 0xffff8023, start: Data, end: Data + 5 });
            expect((await osfile(t, 0)).a).toBe(1);
            await t.volume.flush();
            const saved = t.files("GREET");
            expect(text(saved.data)).toBe("HELLO");
            expect(saved).toMatchObject({ load: 0xffff1900, exec: 0xffff8023, locked: false });
        });

        it("loads a file at its own address unless the exec address's low byte is zero", async () => {
            const t = await hostWith([file("GREET", "HELLO", { load: 0x1900, exec: 0x1900 })]);
            fileBlock(t.cpu, "GREET", { load: 0x3000, exec: 0x1 });
            expect((await osfile(t, 0xff)).a).toBe(1);
            expect(text(t.cpu.memory.subarray(0x1900, 0x1905))).toBe("HELLO");
            fileBlock(t.cpu, "GREET", { load: 0x3000, exec: 0 });
            await osfile(t, 0xff);
            expect(text(t.cpu.memory.subarray(0x3000, 0x3005))).toBe("HELLO");
            expect(getLong(t.cpu, Block + 2)).toBe(0x3000);
            expect(getLong(t.cpu, Block + 10)).toBe(5);
        });

        it("reads a file's information, and says there is nothing there without an error", async () => {
            const t = await hostWith([file("GREET", "HELLO", { load: 5, exec: 6, locked: true }), directory("DIR")]);
            fileBlock(t.cpu, "GREET");
            expect((await osfile(t, 5)).a).toBe(1);
            expect([2, 6, 10, 14].map((offset) => getLong(t.cpu, Block + offset))).toEqual([5, 6, 5, 0x0b]);
            fileBlock(t.cpu, "DIR");
            expect((await osfile(t, 5)).a).toBe(2);
            fileBlock(t.cpu, "MISSING");
            expect((await osfile(t, 5)).a).toBe(0);
        });

        it("raises Not found when asked to load what is not there", async () => {
            const t = await hostWith();
            fileBlock(t.cpu, "MISSING");
            expect(errorOf(await osfile(t, 0xff))).toEqual({ op: "error", number: 0xd6, text: "Not found" });
        });

        it("writes a file's addresses and lock", async () => {
            const t = await hostWith([file("GREET", "HELLO")]);
            fileBlock(t.cpu, "GREET", { load: 0x11, exec: 0x22 });
            putLong(t.cpu, Block + 14, 0x08);
            await osfile(t, 1);
            await t.volume.flush();
            expect(t.files("GREET")).toMatchObject({ load: 0x11, exec: 0x22, locked: true });
            fileBlock(t.cpu, "GREET", { load: 0x33 });
            await osfile(t, 2);
            expect(t.volume.root.children.get("GREET")).toMatchObject({ load: 0x33, exec: 0x22 });
        });

        it("refuses to replace or delete a locked file", async () => {
            const t = await hostWith([file("KEEP", "x", { locked: true })]);
            fileBlock(t.cpu, "KEEP", { start: Data, end: Data });
            expect(errorOf(await osfile(t, 0)).text).toBe("Locked");
            expect(errorOf(await osfile(t, 6)).text).toBe("Locked");
        });

        it("deletes a file, and makes a directory", async () => {
            const t = await hostWith([file("GONE", "x")]);
            fileBlock(t.cpu, "GONE");
            expect((await osfile(t, 6)).a).toBe(1);
            fileBlock(t.cpu, "NEWDIR");
            expect((await osfile(t, 8)).a).toBe(2);
            await t.volume.flush();
            expect(t.store.log).toEqual([
                ["remove", "GONE"],
                ["makeDirectory", "NEWDIR"],
            ]);
        });

        it("ends a name at a space, as the OS leaves the rest of a *SAVE line after it", async () => {
            const t = await hostWith([file("GREET", "HELLO")]);
            fileBlock(t.cpu, "GREET 3000 +5");
            expect((await osfile(t, 5)).a).toBe(1);
        });

        it("will not move data to or from a second processor, whose addresses are those without all ones above", async () => {
            const t = await hostWith(
                [file("MINE", "HELLO", { load: 0xffff1900 }), file("THEIRS", "HELLO", { load: 0x1900 })],
                { hasTube: true },
            );
            fileBlock(t.cpu, "MINE", { exec: 1 });
            expect(errorOf(await osfile(t, 0xff))).toBeUndefined();
            fileBlock(t.cpu, "THEIRS", { exec: 1 });
            expect(errorOf(await osfile(t, 0xff)).text).toMatch(/Tube/);
        });
    });

    describe("what the 6502 can ask for", () => {
        it("will not save, read or write more than the machine's memory holds", async () => {
            const t = await hostWith([file("DATA", "x")]);
            fileBlock(t.cpu, "BIG", { start: 0, end: 0xffffffff });
            expect(errorOf(await osfile(t, 0)).text).toBe("Bad address");
            const handle = await open(t, "DATA", 0xc0);
            putLong(t.cpu, Block, 0);
            t.cpu.memory[Block] = handle;
            putLong(t.cpu, Block + 1, Data);
            putLong(t.cpu, Block + 5, 0xffffffff);
            putLong(t.cpu, Block + 9, 0);
            expect(errorOf(await t.call(Call.gbpb, { a: 2, x: Block & 0xff, y: Block >> 8 })).text).toBe("Bad address");
            expect(t.volume.root.children.get("DATA").length).toBe(1);
        });

        it("lets a transfer of nothing be anywhere", async () => {
            const t = await hostWith([file("EMPTY", "")]);
            fileBlock(t.cpu, "EMPTY", { load: 0xfd00 });
            expect(errorOf(await osfile(t, 0xff))).toBeUndefined();
        });

        it("will not let a file grow past the size it allows", async () => {
            const t = await hostWith([file("DATA", "x")]);
            const handle = await open(t, "DATA", 0xc0);
            putLong(t.cpu, 0x70, 0xffffffff);
            expect(errorOf(await t.call(Call.args, { a: 3, x: 0x70, y: handle })).text).toBe("File too big");
        });

        it("will not load over the devices, or past the top of memory", async () => {
            const t = await hostWith([file("DATA", "xx")]);
            fileBlock(t.cpu, "DATA", { load: 0xfc00 });
            expect(errorOf(await osfile(t, 0xff)).text).toBe("Bad address");
            fileBlock(t.cpu, "DATA", { load: 0xffff });
            expect(errorOf(await osfile(t, 0xff)).text).toBe("Bad address");
            fileBlock(t.cpu, "DATA", { load: 0x8000 });
            expect(errorOf(await osfile(t, 0xff))).toBeUndefined();
        });

        it("will not run, or load at its own address, a file that has no addresses, which is any with no .inf", async () => {
            const t = await hostWith([file("PLAIN", "xx")]);
            putString(t.cpu, Name, "PLAIN");
            expect(errorOf(await t.call(Call.fsc, { a: 4, x: Name & 0xff, y: Name >> 8 })).text).toBe(
                "No load address",
            );
            fileBlock(t.cpu, "PLAIN", { exec: 1 });
            expect(errorOf(await osfile(t, 0xff)).text).toBe("No load address");
            fileBlock(t.cpu, "PLAIN", { load: Data });
            expect(errorOf(await osfile(t, 0xff))).toBeUndefined();
        });

        it("cuts an error's text short, since the ROM builds it in the page the stack is in", async () => {
            const t = await hostWith();
            t.host._file = () => {
                throw new TypeError("x".repeat(500));
            };
            expect(errorOf(await t.call(Call.file, { a: 0 })).text.length).toBe(80);
        });
    });

    describe("what is left of a response", () => {
        it("keeps nothing of one the ROM does not come back to read, as after a *RUN or an error", async () => {
            const t = await hostWith([file("PROG", "x", { load: 0x1900, exec: 0x1900 })]);
            putString(t.cpu, Name, "PROG");
            await t.call(Call.fsc, { a: 4, x: Name & 0xff, y: Name >> 8 });
            fileBlock(t.cpu, "MISSING");
            await osfile(t, 0xff);
            expect(t.host.openStreams).toBe(0);
        });

        it("keeps nothing of a response across a break", async () => {
            const t = await hostWith();
            t.host.write(Port.call, Call.args);
            expect(t.host.openStreams).toBe(1);
            t.host.reset();
            expect(t.host.openStreams).toBe(0);
        });
    });

    describe("names that are the root, the library and the like", () => {
        it.each([["$.%"], ["$.&"], ["$.$"]])("will not make a file called %s", async (name) => {
            const t = await hostWith();
            putString(t.cpu, Name, name);
            expect(errorOf(await t.call(Call.find, { a: 0x80, x: Name & 0xff, y: Name >> 8 })).text).toBe("Bad name");
        });
    });

    describe("what has gone from the tree", () => {
        it("does not write a deleted file back when the channel that had it open is closed", async () => {
            const t = await hostWith();
            const handle = await open(t, "OUT", 0x80);
            await t.call(Call.bput, { a: 0x41, y: handle });
            t.host._runCommand("DELETE", "OUT", { print() {} });
            await t.call(Call.find, { a: 0, y: handle });
            await t.volume.flush();
            expect(t.store.files.size).toBe(0);
        });

        it("does not let the file an open channel had be written over what replaced it", async () => {
            const t = await hostWith();
            const first = await open(t, "OUT", 0x80);
            await t.call(Call.bput, { a: 0x41, y: first });
            const second = await open(t, "OUT", 0x80);
            await t.call(Call.bput, { a: 0x42, y: second });
            await t.call(Call.find, { a: 0, y: second });
            await t.call(Call.find, { a: 0, y: first });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("B");
        });

        it("will not open a locked file for update", async () => {
            const t = await hostWith([file("KEEP", "x", { locked: true })]);
            putString(t.cpu, Name, "KEEP");
            expect(errorOf(await t.call(Call.find, { a: 0xc0, x: Name & 0xff, y: Name >> 8 })).text).toBe("Locked");
            expect(await open(t, "KEEP", 0x40)).toBe(FirstHandle);
        });

        it("will not delete the root, and goes back to the root if the directory it is in is deleted", async () => {
            const t = await hostWith([directory("D")]);
            fileBlock(t.cpu, "$");
            expect(errorOf(await osfile(t, 6)).text).toBe("Access violation");
            t.host.directory = t.volume.root.children.get("D");
            t.host._runCommand("DELETE", "$.D", { print() {} });
            expect(t.host.directory).toBe(t.volume.root);
        });
    });

    describe("names", () => {
        const items = [
            directory("GAMES"),
            file("GAMES.ELITE", "e"),
            file("TOP", "t"),
            directory("GAMES.SUB"),
            file("GAMES.SUB.DEEP", "d"),
        ];
        const exists = async (t, name) => {
            fileBlock(t.cpu, name);
            return (await osfile(t, 5)).a;
        };

        it("follows directories, the root, the parent, and the current and library directories", async () => {
            const t = await hostWith(items);
            expect(await exists(t, "GAMES.ELITE")).toBe(1);
            expect(await exists(t, "$.GAMES.SUB.DEEP")).toBe(1);
            expect(await exists(t, ":0.$.TOP")).toBe(1);
            expect(await exists(t, "games.elite")).toBe(1);
            expect(await exists(t, "GAMES.^.TOP")).toBe(1);
            expect(await exists(t, "%.TOP")).toBe(1);
            expect(await exists(t, "@.TOP")).toBe(1);
            expect(await exists(t, "GAMES")).toBe(2);
        });

        it("says Bad name for a part that cannot be one, and Not found for a directory that is not there", async () => {
            const t = await hostWith(items);
            fileBlock(t.cpu, "TOO.LONG.A.NAME.FOR.IT.NOT");
            expect(errorOf(await osfile(t, 5)).text).toBe("Not found");
            fileBlock(t.cpu, "ELEVENCHARS");
            expect(errorOf(await osfile(t, 5)).text).toBe("Bad name");
            fileBlock(t.cpu, "A..B");
            expect(errorOf(await osfile(t, 5)).text).toBe("Bad name");
        });
    });

    describe("open files", () => {
        it("reads a file a byte at a time, and says when it is at the end", async () => {
            const t = await hostWith([file("DATA", "AB")]);
            const handle = await open(t, "DATA", 0x40);
            expect(handle).toBe(FirstHandle);
            const bytes = [];
            for (let index = 0; index < 3; index++) {
                const result = await t.call(Call.bget, { y: handle });
                bytes.push([result.a, !!(result.p & Carry)]);
            }
            expect(bytes).toEqual([
                [0x41, false],
                [0x42, false],
                [0xfe, true],
            ]);
            expect((await t.call(Call.fsc, { a: 1, x: handle })).x).toBe(0xff);
        });

        it("writes a file a byte at a time, and the store has it once it is closed", async () => {
            const t = await hostWith();
            const handle = await open(t, "OUT", 0x80);
            for (const byte of "hello") await t.call(Call.bput, { a: byte.charCodeAt(0), y: handle });
            await t.volume.flush();
            expect(t.files("OUT")).toBeUndefined();
            await t.call(Call.find, { a: 0, y: handle });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("hello");
        });

        it("reports and sets the pointer and the extent", async () => {
            const t = await hostWith([file("DATA", "ABCDEF")]);
            const handle = await open(t, "DATA", 0xc0);
            const argument = 0x70;
            await t.call(Call.args, { a: 2, x: argument, y: handle });
            expect(getLong(t.cpu, argument)).toBe(6);
            putLong(t.cpu, argument, 4);
            await t.call(Call.args, { a: 1, x: argument, y: handle });
            expect((await t.call(Call.bget, { y: handle })).a).toBe("E".charCodeAt(0));
            await t.call(Call.args, { a: 0, x: argument, y: handle });
            expect(getLong(t.cpu, argument)).toBe(5);
            putLong(t.cpu, argument, 2);
            await t.call(Call.args, { a: 3, x: argument, y: handle });
            await t.call(Call.args, { a: 2, x: argument, y: handle });
            expect(getLong(t.cpu, argument)).toBe(2);
        });

        it("answers OSARGS for no file with the filing system's number", async () => {
            const t = await hostWith();
            expect((await t.call(Call.args, { a: 0, y: 0 })).a).toBe(FilingSystemNumber);
        });

        it("gives 0 for a file that is not there, and an error for one that is a directory", async () => {
            const t = await hostWith([directory("DIR")]);
            expect(await open(t, "MISSING", 0x40)).toBe(0);
            putString(t.cpu, Name, "DIR");
            expect(errorOf(await t.call(Call.find, { a: 0x40, x: Name & 0xff, y: Name >> 8 })).text).toBe(
                "Is a directory",
            );
        });

        it("runs out of handles at the end of the range the filing system declared", async () => {
            const t = await hostWith([file("DATA", "x")]);
            const range = await t.call(Call.fsc, { a: 7 });
            expect([range.x, range.y]).toEqual([FirstHandle, LastHandle]);
            for (let index = FirstHandle; index <= LastHandle; index++) await open(t, "DATA", 0x40);
            putString(t.cpu, Name, "DATA");
            expect(errorOf(await t.call(Call.find, { a: 0x40, x: Name & 0xff, y: Name >> 8 })).text).toBe(
                "Too many open files",
            );
        });

        it("says Channel for a handle that is not open", async () => {
            const t = await hostWith();
            expect(errorOf(await t.call(Call.bget, { y: 0x15 })).text).toBe("Channel");
        });

        it("closes everything with a close of handle 0, keeping what was written", async () => {
            const t = await hostWith();
            const handle = await open(t, "OUT", 0x80);
            await t.call(Call.bput, { a: 0x41, y: handle });
            await t.call(Call.find, { a: 0, y: 0 });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("A");
            expect(errorOf(await t.call(Call.bget, { y: handle })).text).toBe("Channel");
        });

        it("writes what a break leaves open, since the files are closed by it", async () => {
            const t = await hostWith();
            const handle = await open(t, "OUT", 0x80);
            await t.call(Call.bput, { a: 0x41, y: handle });
            t.host.reset();
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("A");
        });
    });

    describe("OSGBPB", () => {
        const block = (t, handle, address, count, pointer) => {
            t.cpu.memory[Block] = handle;
            putLong(t.cpu, Block + 1, address);
            putLong(t.cpu, Block + 5, count);
            putLong(t.cpu, Block + 9, pointer);
        };
        const gbpb = (t, action) => t.call(Call.gbpb, { a: action, x: Block & 0xff, y: Block >> 8 });

        it("reads bytes from the pointer or from the one it is given, and says when it ran short", async () => {
            const t = await hostWith([file("DATA", "ABCDEF")]);
            const handle = await open(t, "DATA", 0x40);
            block(t, handle, Data, 4, 1);
            expect((await gbpb(t, 3)).p & Carry).toBe(0);
            expect(text(t.cpu.memory.subarray(Data, Data + 4))).toBe("BCDE");
            expect(getLong(t.cpu, Block + 9)).toBe(5);
            block(t, handle, Data, 4, 0);
            const short = await gbpb(t, 4);
            expect(short.p & Carry).toBe(Carry);
            expect(getLong(t.cpu, Block + 5)).toBe(3);
            expect(getLong(t.cpu, Block + 1)).toBe(Data + 1);
        });

        it("writes bytes, growing the file", async () => {
            const t = await hostWith();
            const handle = await open(t, "OUT", 0x80);
            t.cpu.memory.set(new TextEncoder().encode("abcdef"), Data);
            block(t, handle, Data, 6, 0);
            await gbpb(t, 1);
            block(t, handle, Data, 3, 2);
            await gbpb(t, 1);
            await t.call(Call.find, { a: 0, y: handle });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("ababcf");
        });

        it("says what it does not do", async () => {
            const t = await hostWith();
            expect(errorOf(await gbpb(t, 5)).text).toMatch(/not supported/);
        });
    });

    describe("filing system commands", () => {
        const items = [
            directory("GAMES"),
            file("GAMES.ELITE", "elite", { load: 0x1900, exec: 0x1900 }),
            file("TOP", "top", { locked: true }),
        ];
        const command = (t, line) => {
            putString(t.cpu, Name, line);
            return t.call(Call.fsc, { a: 3, x: Name & 0xff, y: Name >> 8 });
        };
        const printed = (result) =>
            result.ops
                .filter((op) => op.op === "print")
                .map((op) => op.text)
                .join("");

        it("lists the directory the *CAT names, or the current one", async () => {
            const t = await hostWith(items);
            putString(t.cpu, Name, "");
            const listing = printed(await t.call(Call.fsc, { a: 5, x: Name & 0xff, y: Name >> 8 }));
            expect(listing).toContain("Dir. $  Lib. $");
            expect(listing).toContain("GAMES     D");
            expect(listing).toContain("TOP       L");
            putString(t.cpu, Name, "GAMES");
            expect(printed(await t.call(Call.fsc, { a: 5, x: Name & 0xff, y: Name >> 8 }))).toContain("ELITE");
        });

        it("changes directory with *DIR, and the library with *LIB", async () => {
            const t = await hostWith(items);
            await command(t, "DIR GAMES");
            fileBlock(t.cpu, "ELITE");
            expect((await osfile(t, 5)).a).toBe(1);
            await command(t, "DIR");
            fileBlock(t.cpu, "ELITE");
            expect((await osfile(t, 5)).a).toBe(0);
            await command(t, "LIB GAMES");
            expect(printed(await command(t, "INFO"))).toContain("GAMES");
            expect(errorOf(await command(t, "DIR TOP")).text).toBe("Not a directory");
        });

        it("shows *INFO with wildcards, and *EX of the whole directory", async () => {
            const t = await hostWith(items);
            const info = printed(await command(t, "INFO T*"));
            expect(info).toBe("TOP        L 00000000 00000000 000003\r");
            expect(printed(await command(t, "EX GAMES.*"))).toContain("ELITE");
            expect(errorOf(await command(t, "INFO NOPE*")).text).toBe("Not found");
        });

        it("creates, deletes and locks", async () => {
            const t = await hostWith(items);
            await command(t, "CDIR NEW");
            await command(t, "ACCESS GAMES.ELITE L");
            expect(errorOf(await command(t, "DELETE GAMES.ELITE")).text).toBe("Locked");
            await command(t, "ACCESS GAMES.ELITE");
            await command(t, "DELETE GAMES.ELITE");
            await t.volume.flush();
            expect(t.store.log).toEqual([
                ["makeDirectory", "NEW"],
                ["writeFile", "GAMES.ELITE"],
                ["writeFile", "GAMES.ELITE"],
                ["remove", "GAMES.ELITE"],
            ]);
            expect(errorOf(await command(t, "CDIR NEW")).text).toBe("Already exists");
        });

        it("runs a file: loading it where it says and handing the ROM its exec address", async () => {
            const t = await hostWith(items);
            const run = await command(t, "GAMES.ELITE");
            expect(run.ops).toEqual([{ op: "exec", address: 0x1900 }]);
            expect(text(t.cpu.memory.subarray(0x1900, 0x1905))).toBe("elite");
            putString(t.cpu, Name, "GAMES.ELITE");
            expect((await t.call(Call.fsc, { a: 4, x: Name & 0xff, y: Name >> 8 })).ops).toEqual([
                { op: "exec", address: 0x1900 },
            ]);
        });

        it("runs a file from the library when it is not in the current directory", async () => {
            const t = await hostWith(items);
            await command(t, "LIB GAMES");
            await command(t, "DIR GAMES");
            await command(t, "DIR");
            expect((await command(t, "ELITE")).ops).toEqual([{ op: "exec", address: 0x1900 }]);
        });

        it("says Bad command for a name that is neither a command nor a file", async () => {
            const t = await hostWith(items);
            expect(errorOf(await command(t, "FOO"))).toEqual({ op: "error", number: 0xfe, text: "Bad command" });
            expect(errorOf(await command(t, "NO.SUCH.THING")).text).toBe("Bad command");
        });
    });

    describe("service calls", () => {
        const service = (t, a, { y = 0, line = "" } = {}) => {
            putString(t.cpu, 0x2200, line);
            t.cpu.memory[0xf2] = 0x00;
            t.cpu.memory[0xf3] = 0x22;
            return t.call(Call.service, { a, x: 13, y });
        };

        it("claims *VDFS, selecting the filing system, and leaves other commands alone", async () => {
            const t = await hostWith();
            const selected = await service(t, 4, { line: "VDFS" });
            expect(selected.ops).toEqual([{ op: "claim" }]);
            expect(selected.a).toBe(0);
            expect(t.host.selected).toBe(true);
            expect((await service(t, 4, { line: "NOPE" })).a).toBe(4);
        });

        it("answers the selection of its filing system number, and not another's", async () => {
            const t = await hostWith();
            expect((await service(t, 0x12, { y: 4 })).ops).toEqual([]);
            const selected = await service(t, 0x12, { y: FilingSystemNumber });
            expect(selected.ops).toEqual([{ op: "claim" }]);
            expect(selected.a).toBe(0);
        });

        it("takes over a command, such as *DIR, ahead of other filing systems once it is selected", async () => {
            const t = await hostWith([directory("GAMES")]);
            expect((await service(t, 4, { line: "DIR GAMES" })).a).toBe(4);
            await service(t, 4, { line: "VDFS" });
            expect((await service(t, 4, { line: "DIR GAMES" })).a).toBe(0);
            expect(t.host.directory.name).toBe("GAMES");
        });

        it("stops being the selected filing system when another is chosen, but not by its own reselection", async () => {
            const t = await hostWith();
            await service(t, 4, { line: "VDFS" });
            await t.call(Call.fsc, { a: 6 });
            expect(t.host.selected).toBe(false);
            await service(t, 4, { line: "VDFS" });
            await service(t, 4, { line: "VDFS" });
            await t.call(Call.fsc, { a: 6 });
            expect(t.host.selected).toBe(true);
        });

        it("introduces itself under *HELP, and lists its commands under *HELP VDFS", async () => {
            const t = await hostWith();
            const help = await service(t, 9);
            expect(help.ops).toEqual([{ op: "print", text: "  VDFS 0.1\r" }]);
            expect(help.a).toBe(9);
            expect((await service(t, 9, { line: "VDFS" })).ops[0].text).toMatch(/ACCESS CAT CDIR DELETE DIR/);
            expect((await service(t, 9, { line: "OTHER" })).ops).toEqual([]);
        });
    });

    describe("machines it is not for", () => {
        it.each([["Atom-Tape"], ["BBC B (MOS 0.10)"]])("is refused by the %s, which it would break", (name) => {
            expect(() => fake6502(findModel(name), { vdfs: { volume: {} } })).toThrow(/VDFS is not for/);
        });
    });

    describe("faults", () => {
        it("turns a failure of its own into an error on the 6502 instead of throwing into the emulator", async () => {
            const t = await hostWith();
            t.host._file = () => {
                throw new TypeError("oops");
            };
            const result = await t.call(Call.file, { a: 0 });
            expect(errorOf(result).text).toMatch(/oops/);
        });
    });
});
