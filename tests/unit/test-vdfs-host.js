import { describe, expect, it, vi } from "vitest";

import { FilingSystemNumber, Osargs, Osfile, Osfind, Osgbpb, VdfsHost } from "../../src/vdfs-host.js";
import { FirstHandle, LastHandle } from "../../src/vdfs-channels.js";
import { Call, Port } from "../../src/vdfs-protocol.js";
import { VdfsVolume } from "../../src/vdfs-volume.js";
import {
    Block,
    Data,
    Name,
    directory,
    errorOf,
    fakeCpu,
    file,
    getLong,
    hostWith,
    printed,
    putLong,
    putString,
    text,
    xy,
} from "../helpers/vdfs.js";

const Carry = 0x01;
const Program = { load: 0x1900, exec: 0x1900 };

/** The control block of an OSGBPB call, in memory. */
function gbpbBlock(t, { handle, address = Data, count, pointer = 0 }) {
    t.cpu.memory[Block] = handle;
    putLong(t.cpu, Block + 1, address);
    putLong(t.cpu, Block + 5, count);
    putLong(t.cpu, Block + 9, pointer);
}

const gbpb = (t, action) => t.call(Call.gbpb, { a: action, ...xy(Block) });

describe("VDFS host", () => {
    describe("OSFILE", () => {
        it("saves the bytes in memory as a file, with its addresses, and writes it to the store", async () => {
            const t = await hostWith();
            t.cpu.memory.set(new TextEncoder().encode("HELLO"), Data);
            const saved = t.osfile(Osfile.save, "GREET", {
                load: 0xffff1900,
                exec: 0xffff8023,
                start: Data,
                end: Data + 5,
            });
            expect(saved.a).toBe(1);
            await t.volume.flush();
            expect(text(t.files("GREET").data)).toBe("HELLO");
            expect(t.files("GREET")).toMatchObject({ load: 0xffff1900, exec: 0xffff8023, locked: false });
        });

        it("loads a file at its own address unless the exec address's low byte is zero", async () => {
            const t = await hostWith([file("GREET", "HELLO", Program)]);
            expect(t.osfile(Osfile.load, "GREET", { load: Data, exec: 1 }).a).toBe(1);
            expect(text(t.cpu.memory.subarray(0x1900, 0x1905))).toBe("HELLO");
            t.osfile(Osfile.load, "GREET", { load: Data, exec: 0 });
            expect(text(t.cpu.memory.subarray(Data, Data + 5))).toBe("HELLO");
            expect(getLong(t.cpu, Block + 2)).toBe(Data);
            expect(getLong(t.cpu, Block + 10)).toBe(5);
        });

        it("reads a file's information, and says there is nothing there without an error", async () => {
            const t = await hostWith([file("GREET", "HELLO", { load: 5, exec: 6, locked: true }), directory("DIR")]);
            expect(t.osfile(Osfile.readInformation, "GREET").a).toBe(1);
            expect([2, 6, 10, 14].map((offset) => getLong(t.cpu, Block + offset))).toEqual([5, 6, 5, 0x0b]);
            expect(t.osfile(Osfile.readInformation, "DIR").a).toBe(2);
            expect(t.osfile(Osfile.readInformation, "MISSING").a).toBe(0);
        });

        it("writes a file's addresses and lock, each on its own or all together", async () => {
            const t = await hostWith([file("GREET", "HELLO", { load: 1, exec: 2 })]);
            const greet = () => t.volume.root.children.get("GREET");
            t.osfile(Osfile.writeLoad, "GREET", { load: 0x11, exec: 0x22 });
            expect(greet()).toMatchObject({ load: 0x11, exec: 2 });
            t.osfile(Osfile.writeExec, "GREET", { load: 0x33, exec: 0x44 });
            expect(greet()).toMatchObject({ load: 0x11, exec: 0x44 });
            putLong(t.cpu, Block + 14, 0x08);
            t.call(Call.file, { a: Osfile.writeAttributes, ...xy(Block) });
            expect(greet()).toMatchObject({ load: 0x11, exec: 0x44, locked: true });
            t.osfile(Osfile.writeInformation, "GREET", { load: 0x55, exec: 0x66 });
            await t.volume.flush();
            expect(t.files("GREET")).toMatchObject({ load: 0x55, exec: 0x66, locked: false });
        });

        it.each([
            ["saves over", Osfile.save, "KEEP"],
            ["deletes", Osfile.delete, "KEEP"],
        ])("refuses to replace or delete a locked file: %s", async (_, action) => {
            const t = await hostWith([file("KEEP", "x", { locked: true })]);
            expect(errorOf(t.osfile(action, "KEEP", { start: Data, end: Data })).text).toBe("Locked");
        });

        it("deletes a file, and makes a directory", async () => {
            const t = await hostWith([file("GONE", "x")]);
            expect(t.osfile(Osfile.delete, "GONE").a).toBe(1);
            expect(t.osfile(Osfile.createDirectory, "NEWDIR").a).toBe(2);
            await t.volume.flush();
            expect(t.store.log).toEqual([
                ["remove", "GONE"],
                ["makeDirectory", "NEWDIR"],
            ]);
        });

        it.each([
            ["write information on what is not there", Osfile.writeInformation, "MISSING", {}, { a: 0 }],
            ["write attributes on what is not there", Osfile.writeAttributes, "MISSING", {}, { a: 0 }],
            ["delete what is not there", Osfile.delete, "MISSING", {}, { a: 0 }],
            ["make a directory that is there", Osfile.createDirectory, "DIR", {}, { a: 2 }],
            ["make a directory where a file is", Osfile.createDirectory, "FILE", {}, { error: "Already exists" }],
            ["save over a directory", Osfile.save, "DIR", { start: Data, end: Data }, { error: "Is a directory" }],
            [
                "save from the end to the start",
                Osfile.save,
                "NEW",
                { start: Data + 1, end: Data },
                { error: "Bad address" },
            ],
            ["load what is not there", Osfile.load, "MISSING", {}, { error: "Not found" }],
            ["load a directory", Osfile.load, "DIR", {}, { error: "Is a directory" }],
            ["do what OSFILE 7 asks", 7, "FILE", {}, { error: "OSFILE 7 is not supported" }],
        ])("will %s", async (_, action, name, fields, expected) => {
            const t = await hostWith([directory("DIR"), file("FILE", "x")]);
            const result = t.osfile(action, name, fields);
            if (expected.error) expect(errorOf(result).text).toBe(expected.error);
            else expect(result.a).toBe(expected.a);
        });

        it("will not move data to or from a second processor, whose addresses are those without all ones above", async () => {
            const t = await hostWith(
                [file("MINE", "HELLO", { load: 0xffff1900 }), file("THEIRS", "HELLO", { load: 0x1900 })],
                { hasTube: true },
            );
            expect(errorOf(t.osfile(Osfile.load, "MINE", { exec: 1 }))).toBeUndefined();
            expect(errorOf(t.osfile(Osfile.load, "THEIRS", { exec: 1 })).text).toMatch(/Tube/);
        });
    });

    describe("what the 6502 can ask for", () => {
        it("will not save, read or write more than the machine's memory holds", async () => {
            const t = await hostWith([file("DATA", "x")]);
            expect(errorOf(t.osfile(Osfile.save, "BIG", { start: 0, end: 0xffffffff })).text).toBe("Bad address");
            const handle = t.open("DATA", Osfind.update).a;
            gbpbBlock(t, { handle, count: 0xffffffff });
            expect(errorOf(gbpb(t, Osgbpb.write)).text).toBe("Bad address");
            expect(t.volume.root.children.get("DATA").length).toBe(1);
        });

        it("will not let a file grow past the size it allows", async () => {
            const t = await hostWith([file("DATA", "x")]);
            const handle = t.open("DATA", Osfind.update).a;
            putLong(t.cpu, 0x70, 0xffffffff);
            expect(errorOf(t.call(Call.args, { a: Osargs.setExtent, x: 0x70, y: handle })).text).toBe("File too big");
        });

        it("will not load over the devices, or past the top of memory, but will load nothing anywhere", async () => {
            const t = await hostWith([file("DATA", "xx"), file("EMPTY", "")]);
            expect(errorOf(t.osfile(Osfile.load, "DATA", { load: 0xfc00 })).text).toBe("Bad address");
            expect(errorOf(t.osfile(Osfile.load, "DATA", { load: 0xffff })).text).toBe("Bad address");
            expect(errorOf(t.osfile(Osfile.load, "DATA", { load: 0x8000 }))).toBeUndefined();
            expect(errorOf(t.osfile(Osfile.load, "EMPTY", { load: 0xfd00 }))).toBeUndefined();
        });

        it("will not run, or load at its own address, a file that has no addresses, which is any with no .inf", async () => {
            const t = await hostWith([file("PLAIN", "xx")]);
            putString(t.cpu, Name, "PLAIN");
            expect(errorOf(t.call(Call.fsc, { a: 4, ...xy(Name) })).text).toBe("No load address");
            expect(errorOf(t.osfile(Osfile.load, "PLAIN", { exec: 1 })).text).toBe("No load address");
            expect(errorOf(t.osfile(Osfile.load, "PLAIN", { load: Data }))).toBeUndefined();
        });

        it("turns a failure of its own into an error on the 6502, cut short, instead of throwing into the emulator", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const t = await hostWith();
            t.cpu.peekmem = () => {
                throw new TypeError("x".repeat(500));
            };
            const error = errorOf(t.call(Call.file, { a: Osfile.readInformation }));
            expect(error.text).toMatch(/^VDFS host failure/);
            expect(error.text.length).toBe(80);
            vi.restoreAllMocks();
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
        const exists = (t, name) => t.osfile(Osfile.readInformation, name).a;

        it("follows directories, the root, the parent, and the current and library directories", async () => {
            const t = await hostWith(items);
            expect(exists(t, "GAMES.ELITE")).toBe(1);
            expect(exists(t, "$.GAMES.SUB.DEEP")).toBe(1);
            expect(exists(t, ":0.$.TOP")).toBe(1);
            expect(exists(t, "games.elite")).toBe(1);
            expect(exists(t, "GAMES.^.TOP")).toBe(1);
            expect(exists(t, "%.TOP")).toBe(1);
            expect(exists(t, "@.TOP")).toBe(1);
            expect(exists(t, "GAMES")).toBe(2);
        });

        it.each([
            ["a directory that is not there", "NOWHERE.A.NAME", "Not found"],
            ["a name that is too long", "ELEVENCHARS", "Bad name"],
            ["an empty part", "A..B", "Bad name"],
            ["a special directory in the middle", "GAMES.$.TOP", "Bad name"],
        ])("says what is wrong with %s", async (_, name, error) => {
            const t = await hostWith(items);
            expect(errorOf(t.osfile(Osfile.readInformation, name)).text).toBe(error);
        });

        it.each([["$.%"], ["$.&"], ["$.$"]])("will not make a file called %s", async (name) => {
            const t = await hostWith();
            expect(errorOf(t.open(name, Osfind.write)).text).toBe("Bad name");
        });
    });

    describe("open files", () => {
        it("reads a file a byte at a time, and says when it is at the end", async () => {
            const t = await hostWith([file("DATA", "AB")]);
            const handle = t.open("DATA", Osfind.read).a;
            expect(handle).toBe(FirstHandle);
            const bytes = [0, 1, 2].map(() => {
                const result = t.call(Call.bget, { y: handle });
                return [result.a, !!(result.p & Carry)];
            });
            expect(bytes).toEqual([
                [0x41, false],
                [0x42, false],
                [0xfe, true],
            ]);
            expect(t.call(Call.fsc, { a: 1, x: handle }).x).toBe(0xff);
        });

        it("raises EOF for a byte read past the end, which a pointer set beyond it makes", async () => {
            const t = await hostWith([file("DATA", "AB")]);
            const handle = t.open("DATA", Osfind.read).a;
            putLong(t.cpu, 0x70, 5);
            t.call(Call.args, { a: Osargs.setPointer, x: 0x70, y: handle });
            expect(errorOf(t.call(Call.bget, { y: handle })).text).toBe("EOF");
        });

        it("writes a file a byte at a time, and the store has it once it is closed", async () => {
            const t = await hostWith();
            const handle = t.open("OUT", Osfind.write).a;
            for (const byte of "hello") t.call(Call.bput, { a: byte.charCodeAt(0), y: handle });
            await t.volume.flush();
            expect(t.files("OUT")).toBeUndefined();
            t.call(Call.find, { a: Osfind.close, y: handle });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("hello");
        });

        it("hands over what is written on an OSARGS flush, for one file or for all, leaving it open", async () => {
            const t = await hostWith();
            const first = t.open("ONE", Osfind.write).a;
            const second = t.open("TWO", Osfind.write).a;
            t.call(Call.bput, { a: 1, y: first });
            t.call(Call.bput, { a: 2, y: second });
            t.call(Call.args, { a: Osargs.flush, y: first });
            await t.volume.flush();
            expect([...t.store.files.keys()]).toEqual(["ONE"]);
            t.call(Call.args, { a: Osargs.flush, y: 0 });
            await t.volume.flush();
            expect([...t.store.files.keys()]).toEqual(["ONE", "TWO"]);
            expect(errorOf(t.call(Call.bput, { a: 3, y: first }))).toBeUndefined();
        });

        it("reports and sets the pointer and the extent", async () => {
            const t = await hostWith([file("DATA", "ABCDEF")]);
            const handle = t.open("DATA", Osfind.update).a;
            const argument = 0x70;
            const args = (a) => t.call(Call.args, { a, x: argument, y: handle });
            args(Osargs.extent);
            expect(getLong(t.cpu, argument)).toBe(6);
            putLong(t.cpu, argument, 4);
            args(Osargs.setPointer);
            expect(t.call(Call.bget, { y: handle }).a).toBe("E".charCodeAt(0));
            args(Osargs.pointer);
            expect(getLong(t.cpu, argument)).toBe(5);
            putLong(t.cpu, argument, 2);
            args(Osargs.setExtent);
            args(Osargs.extent);
            expect(getLong(t.cpu, argument)).toBe(2);
        });

        it("answers OSARGS for no file with the filing system's number", async () => {
            const t = await hostWith();
            expect(t.call(Call.args, { a: 0, y: 0 }).a).toBe(FilingSystemNumber);
        });

        it("gives 0 for a file that is not there, and an error for one that is a directory", async () => {
            const t = await hostWith([directory("DIR")]);
            expect(t.open("MISSING", Osfind.read).a).toBe(0);
            expect(errorOf(t.open("DIR", Osfind.read)).text).toBe("Is a directory");
        });

        it("will not open a locked file for update, but will for reading", async () => {
            const t = await hostWith([file("KEEP", "x", { locked: true })]);
            expect(errorOf(t.open("KEEP", Osfind.update)).text).toBe("Locked");
            expect(t.open("KEEP", Osfind.read).a).toBe(FirstHandle);
        });

        it("runs out of handles at the end of the range the filing system declared", async () => {
            const t = await hostWith([file("DATA", "x")]);
            const range = t.call(Call.fsc, { a: 7 });
            expect([range.x, range.y]).toEqual([FirstHandle, LastHandle]);
            for (let index = FirstHandle; index <= LastHandle; index++) t.open("DATA", Osfind.read);
            expect(errorOf(t.open("DATA", Osfind.read)).text).toBe("Too many open files");
        });

        it("says Channel for a handle that is not open", async () => {
            const t = await hostWith();
            expect(errorOf(t.call(Call.bget, { y: 0x15 })).text).toBe("Channel");
        });

        it("closes everything with a close of handle 0, keeping what was written", async () => {
            const t = await hostWith();
            const handle = t.open("OUT", Osfind.write).a;
            t.call(Call.bput, { a: 0x41, y: handle });
            t.call(Call.find, { a: Osfind.close, y: 0 });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("A");
            expect(errorOf(t.call(Call.bget, { y: handle })).text).toBe("Channel");
        });

        it("writes what a break leaves open, since the files are closed by it", async () => {
            const t = await hostWith();
            const handle = t.open("OUT", Osfind.write).a;
            t.call(Call.bput, { a: 0x41, y: handle });
            t.host.reset();
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("A");
        });

        it("will not write to, or change the extent of, a file that is open for reading", async () => {
            const t = await hostWith([file("DATA", "ABC")]);
            const handle = t.open("DATA", Osfind.read).a;
            gbpbBlock(t, { handle, count: 1 });
            putLong(t.cpu, 0x70, 1);
            const refusals = [
                t.call(Call.bput, { a: 1, y: handle }),
                gbpb(t, Osgbpb.write),
                gbpb(t, Osgbpb.writeAtPointer),
                t.call(Call.args, { a: Osargs.setExtent, x: 0x70, y: handle }),
            ];
            expect(refusals.map((result) => errorOf(result).text)).toEqual(["Locked", "Locked", "Locked", "Locked"]);
        });
    });

    describe("OSGBPB", () => {
        it("reads bytes from the pointer or from the one it is given, and says when it ran short", async () => {
            const t = await hostWith([file("DATA", "ABCDEF")]);
            const handle = t.open("DATA", Osfind.read).a;
            gbpbBlock(t, { handle, count: 4, pointer: 1 });
            expect(gbpb(t, Osgbpb.readAtPointer).p & Carry).toBe(0);
            expect(text(t.cpu.memory.subarray(Data, Data + 4))).toBe("BCDE");
            expect(getLong(t.cpu, Block + 9)).toBe(5);
            gbpbBlock(t, { handle, count: 4 });
            expect(gbpb(t, Osgbpb.read).p & Carry).toBe(Carry);
            expect(getLong(t.cpu, Block + 5)).toBe(3);
            expect(getLong(t.cpu, Block + 1)).toBe(Data + 1);
        });

        it("writes bytes, growing the file", async () => {
            const t = await hostWith();
            const handle = t.open("OUT", Osfind.write).a;
            t.cpu.memory.set(new TextEncoder().encode("abcdef"), Data);
            gbpbBlock(t, { handle, count: 6 });
            gbpb(t, Osgbpb.writeAtPointer);
            gbpbBlock(t, { handle, count: 3, pointer: 2 });
            gbpb(t, Osgbpb.writeAtPointer);
            t.call(Call.find, { a: Osfind.close, y: handle });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("ababcf");
        });

        it("leaves the pointer where it was when the memory it was to fill is not there", async () => {
            const t = await hostWith([file("DATA", "ABCDEF")]);
            const handle = t.open("DATA", Osfind.read).a;
            gbpbBlock(t, { handle, address: 0xfc00, count: 2 });
            expect(errorOf(gbpb(t, Osgbpb.read)).text).toBe("Bad address");
            gbpbBlock(t, { handle, count: 2 });
            gbpb(t, Osgbpb.read);
            expect(text(t.cpu.memory.subarray(Data, Data + 2))).toBe("AB");
        });

        it("says what it does not do", async () => {
            const t = await hostWith();
            expect(errorOf(gbpb(t, 5)).text).toMatch(/not supported/);
        });
    });

    describe("filing system commands", () => {
        const items = [directory("GAMES"), file("GAMES.ELITE", "elite", Program), file("TOP", "top", { locked: true })];

        it("lists the directory the *CAT names, or the current one", async () => {
            const t = await hostWith(items);
            putString(t.cpu, Name, "");
            const listing = printed(t.call(Call.fsc, { a: 5, ...xy(Name) }));
            expect(listing).toContain("Dir. $  Lib. $");
            expect(listing).toContain("GAMES     D");
            expect(listing).toContain("TOP       L");
            putString(t.cpu, Name, "GAMES");
            expect(printed(t.call(Call.fsc, { a: 5, ...xy(Name) }))).toContain("ELITE");
        });

        it("lists three to a line, so a directory of many fits MODE 7", async () => {
            const t = await hostWith(["A", "B", "C", "D", "E"].map((name) => file(name)));
            putString(t.cpu, Name, "");
            const lines = printed(t.call(Call.fsc, { a: 5, ...xy(Name) })).split("\r");
            expect(lines.slice(3, 5).map((line) => line.length)).toEqual([39, 26]);
        });

        it("changes directory with *DIR, and the library with *LIB", async () => {
            const t = await hostWith(items);
            t.command("DIR GAMES");
            expect(t.osfile(Osfile.readInformation, "ELITE").a).toBe(1);
            t.command("DIR");
            expect(t.osfile(Osfile.readInformation, "ELITE").a).toBe(0);
            t.command("LIB GAMES");
            expect(printed(t.command("INFO"))).toContain("GAMES");
            expect(errorOf(t.command("DIR TOP")).text).toBe("Not a directory");
        });

        it("shows *INFO with wildcards, and *EX of the whole directory", async () => {
            const t = await hostWith(items);
            expect(printed(t.command("INFO T*"))).toBe("TOP        L 00000000 00000000 000003\r");
            expect(printed(t.command("EX GAMES.*"))).toContain("ELITE");
            expect(errorOf(t.command("INFO NOPE*")).text).toBe("Not found");
        });

        it("creates, deletes and locks", async () => {
            const t = await hostWith(items);
            t.command("CDIR NEW");
            t.command("ACCESS GAMES.ELITE L");
            expect(errorOf(t.command("DELETE GAMES.ELITE")).text).toBe("Locked");
            t.command("ACCESS GAMES.ELITE");
            t.command("DELETE GAMES.ELITE");
            await t.volume.flush();
            expect(t.store.log).toEqual([
                ["makeDirectory", "NEW"],
                ["writeFile", "GAMES.ELITE"],
                ["writeFile", "GAMES.ELITE"],
                ["remove", "GAMES.ELITE"],
            ]);
            expect(errorOf(t.command("CDIR NEW")).text).toBe("Already exists");
        });

        it.each([["CDIR"], ["DELETE"], ["ACCESS"]])("says Bad name for *%s with no name", async (name) => {
            const t = await hostWith(items);
            expect(errorOf(t.command(name)).text).toBe("Bad name");
        });

        it("will not delete the root, and goes back to the root when the directory or library it is in is deleted", async () => {
            const t = await hostWith([directory("D"), directory("L")]);
            expect(errorOf(t.osfile(Osfile.delete, "$")).text).toBe("Access violation");
            t.command("DIR D");
            t.command("LIB L");
            t.command("DELETE $.D");
            t.command("DELETE $.L");
            expect(printed(t.command("CAT"))).toContain("Dir. $  Lib. $");
        });

        it("runs a file: loading it where it says and handing the ROM its exec address", async () => {
            const t = await hostWith(items);
            expect(t.command("GAMES.ELITE").ops).toEqual([{ op: "exec", address: 0x1900 }]);
            expect(text(t.cpu.memory.subarray(0x1900, 0x1905))).toBe("elite");
            putString(t.cpu, Name, "GAMES.ELITE");
            expect(t.call(Call.fsc, { a: 4, ...xy(Name) }).ops).toEqual([{ op: "exec", address: 0x1900 }]);
        });

        it("runs a file from the library when it is not in the current directory", async () => {
            const t = await hostWith(items);
            t.command("LIB GAMES");
            expect(t.command("ELITE").ops).toEqual([{ op: "exec", address: 0x1900 }]);
        });

        it("will not run a directory, or a file on a machine whose exec address is not the I/O processor's", async () => {
            const t = await hostWith(items);
            expect(errorOf(t.command("GAMES")).text).toBe("Is a directory");
            const tube = await hostWith([file("PROG", "x", { load: 0xffff1900, exec: 0x1900 })], { hasTube: true });
            expect(errorOf(tube.command("PROG")).text).toMatch(/Tube/);
        });

        it("says Bad command for a name that is neither a command nor a file", async () => {
            const t = await hostWith(items);
            expect(errorOf(t.command("FOO"))).toEqual({ op: "error", number: 0xfe, text: "Bad command" });
            expect(errorOf(t.command("NO.SUCH.THING")).text).toBe("Bad command");
        });
    });

    describe("service calls", () => {
        it("claims *VDFS, selecting the filing system, and leaves other commands alone", async () => {
            const t = await hostWith();
            const selected = t.service(4, { line: "VDFS" });
            expect(selected.ops).toEqual([{ op: "claim" }]);
            expect(selected.a).toBe(0);
            expect(t.host.selected).toBe(true);
            expect(t.service(4, { line: "NOPE" }).a).toBe(4);
        });

        it("answers the selection of its filing system number, and not another's", async () => {
            const t = await hostWith();
            expect(t.service(0x12, { y: 4 }).ops).toEqual([]);
            const selected = t.service(0x12, { y: FilingSystemNumber });
            expect(selected.ops).toEqual([{ op: "claim" }]);
            expect(selected.a).toBe(0);
        });

        it("takes over a command, such as *DIR, ahead of other filing systems once it is selected", async () => {
            const t = await hostWith([directory("GAMES"), file("GAMES.ELITE")]);
            expect(t.service(4, { line: "DIR GAMES" }).a).toBe(4);
            t.service(4, { line: "VDFS" });
            expect(t.service(4, { line: "DIR GAMES" }).a).toBe(0);
            expect(printed(t.command("CAT"))).toContain("ELITE");
        });

        it("stops being the selected filing system when another is chosen, but not by its own reselection", async () => {
            const t = await hostWith();
            t.service(4, { line: "VDFS" });
            t.call(Call.fsc, { a: 6 });
            expect(t.host.selected).toBe(false);
            t.service(4, { line: "VDFS" });
            t.service(4, { line: "VDFS" });
            t.call(Call.fsc, { a: 6 });
            expect(t.host.selected).toBe(true);
        });

        it("introduces itself under *HELP, and lists its commands, sorted, under *HELP VDFS", async () => {
            const t = await hostWith();
            const help = t.service(9);
            expect(help.ops).toEqual([{ op: "print", text: "  VDFS 0.1\r" }]);
            expect(help.a).toBe(9);
            expect(t.service(9, { line: "VDFS" }).ops[0].text).toContain(
                "  ACCESS CAT CDIR DELETE DIR EX INFO LIB VDFS\r",
            );
            expect(t.service(9, { line: "OTHER" }).ops).toEqual([]);
        });
    });

    describe("the volume it serves", () => {
        it("reads it when asked, and a volume it cannot read is empty, with the reason kept", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const failure = new Error("no such folder");
            const volume = new VdfsVolume({
                load: async () => {
                    throw failure;
                },
            });
            const host = new VdfsHost(fakeCpu(), volume);
            await host.load();
            expect(host.loadError).toBe(failure);
            expect(volume.root.children.size).toBe(0);
            vi.restoreAllMocks();
        });

        it("hands over what is written, open files included, on a flush, and leaves them open", async () => {
            const t = await hostWith();
            const handle = t.open("OUT", Osfind.write).a;
            t.call(Call.bput, { a: 0x41, y: handle });
            await t.host.flush();
            expect(text(t.files("OUT").data)).toBe("A");
            expect(errorOf(t.call(Call.bput, { a: 0x42, y: handle }))).toBeUndefined();
        });

        it("does not write a deleted file back when the channel that had it open is closed", async () => {
            const t = await hostWith();
            const handle = t.open("OUT", Osfind.write).a;
            t.call(Call.bput, { a: 0x41, y: handle });
            t.command("DELETE OUT");
            t.call(Call.find, { a: Osfind.close, y: handle });
            await t.volume.flush();
            expect(t.store.files.size).toBe(0);
        });

        it("does not let the file an open channel had be written over what replaced it", async () => {
            const t = await hostWith();
            const first = t.open("OUT", Osfind.write).a;
            t.call(Call.bput, { a: 0x41, y: first });
            const second = t.open("OUT", Osfind.write).a;
            t.call(Call.bput, { a: 0x42, y: second });
            t.call(Call.find, { a: Osfind.close, y: second });
            t.call(Call.find, { a: Osfind.close, y: first });
            await t.volume.flush();
            expect(text(t.files("OUT").data)).toBe("B");
        });

        it("keeps nothing of a response across a break", async () => {
            const t = await hostWith();
            t.host.write(Port.call, Call.args);
            expect(t.host.openStreams).toBe(1);
            t.host.reset();
            expect(t.host.openStreams).toBe(0);
        });
    });
});
