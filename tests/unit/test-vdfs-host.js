import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FirstHandle, LastHandle } from "../../src/vdfs-channels.js";
import { FilingSystemNumber, Osargs, Osfile, Osfind, Osgbpb } from "../../src/vdfs-host.js";
import { Busy, Call, Port } from "../../src/vdfs-protocol.js";
import {
    Block,
    Data,
    MemoryStore,
    Name,
    directory,
    errorOf,
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
            const t = hostWith();
            t.cpu.memory.set(new TextEncoder().encode("HELLO"), Data);
            const saved = await t.osfile(Osfile.save, "GREET", {
                load: 0xffff1900,
                exec: 0xffff8023,
                start: Data,
                end: Data + 5,
            });
            expect(saved.a).toBe(1);
            expect(text(t.get("GREET").data)).toBe("HELLO");
            expect(t.get("GREET")).toMatchObject({ load: 0xffff1900, exec: 0xffff8023, locked: false });
        });

        it("loads a file at its own address unless the exec address's low byte is zero", async () => {
            const t = hostWith([file("GREET", "HELLO", Program)]);
            expect((await t.osfile(Osfile.load, "GREET", { load: Data, exec: 1 })).a).toBe(1);
            expect(text(t.cpu.memory.subarray(0x1900, 0x1905))).toBe("HELLO");
            await t.osfile(Osfile.load, "GREET", { load: Data, exec: 0 });
            expect(text(t.cpu.memory.subarray(Data, Data + 5))).toBe("HELLO");
            expect(getLong(t.cpu, Block + 2)).toBe(Data);
            expect(getLong(t.cpu, Block + 10)).toBe(5);
        });

        it("reads a file's information, and says there is nothing there without an error", async () => {
            const t = hostWith([file("GREET", "HELLO", { load: 5, exec: 6, locked: true }), directory("DIR")]);
            expect((await t.osfile(Osfile.readInformation, "GREET")).a).toBe(1);
            expect([2, 6, 10, 14].map((offset) => getLong(t.cpu, Block + offset))).toEqual([5, 6, 5, 0x0b]);
            expect((await t.osfile(Osfile.readInformation, "DIR")).a).toBe(2);
            expect((await t.osfile(Osfile.readInformation, "MISSING")).a).toBe(0);
        });

        it("writes a file's addresses and lock, each on its own or all together, and not what the file holds", async () => {
            const t = hostWith([file("GREET", "HELLO", { load: 1, exec: 2 })]);
            await t.osfile(Osfile.writeLoad, "GREET", { load: 0x11, exec: 0x22 });
            expect(t.get("GREET")).toMatchObject({ load: 0x11, exec: 2 });
            await t.osfile(Osfile.writeExec, "GREET", { load: 0x33, exec: 0x44 });
            expect(t.get("GREET")).toMatchObject({ load: 0x11, exec: 0x44 });
            putLong(t.cpu, Block + 14, 0x08);
            await t.call(Call.file, { a: Osfile.writeAttributes, ...xy(Block) });
            expect(t.get("GREET")).toMatchObject({ load: 0x11, exec: 0x44, locked: true });
            await t.osfile(Osfile.writeInformation, "GREET", { load: 0x55, exec: 0x66 });
            expect(t.get("GREET")).toMatchObject({ load: 0x55, exec: 0x66, locked: false });
            expect(text(t.get("GREET").data)).toBe("HELLO");
        });

        it.each([
            ["saves over", Osfile.save],
            ["deletes", Osfile.delete],
        ])("refuses to replace or delete a locked file: %s", async (_, action) => {
            const t = hostWith([file("KEEP", "x", { locked: true })]);
            expect(errorOf(await t.osfile(action, "KEEP", { start: Data, end: Data })).text).toBe("Locked");
        });

        it("deletes a file, and makes a directory", async () => {
            const t = hostWith([file("GONE", "x")]);
            expect((await t.osfile(Osfile.delete, "GONE")).a).toBe(1);
            expect((await t.osfile(Osfile.createDirectory, "NEWDIR")).a).toBe(2);
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
            const t = hostWith([directory("DIR"), file("FILE", "x")]);
            const result = await t.osfile(action, name, fields);
            if (expected.error) expect(errorOf(result).text).toBe(expected.error);
            else expect(result.a).toBe(expected.a);
        });

        it("will not move data to or from a second processor, whose addresses are those without all ones above", async () => {
            const t = hostWith(
                [file("MINE", "HELLO", { load: 0xffff1900 }), file("THEIRS", "HELLO", { load: 0x1900 })],
                { hasTube: true },
            );
            expect(errorOf(await t.osfile(Osfile.load, "MINE", { exec: 1 }))).toBeUndefined();
            expect(errorOf(await t.osfile(Osfile.load, "THEIRS", { exec: 1 })).text).toMatch(/Tube/);
        });
    });

    describe("what the 6502 can ask for", () => {
        it("will not save, read or write more than the machine's memory holds", async () => {
            const t = hostWith([file("DATA", "x")]);
            expect(errorOf(await t.osfile(Osfile.save, "BIG", { start: 0, end: 0xffffffff })).text).toBe("Bad address");
            const handle = (await t.open("DATA", Osfind.update)).a;
            gbpbBlock(t, { handle, count: 0xffffffff });
            expect(errorOf(await gbpb(t, Osgbpb.write)).text).toBe("Bad address");
            expect(t.get("DATA").data.length).toBe(1);
        });

        it("will not let a file grow past the size it allows", async () => {
            const t = hostWith([file("DATA", "x")]);
            const handle = (await t.open("DATA", Osfind.update)).a;
            putLong(t.cpu, 0x70, 0xffffffff);
            expect(errorOf(await t.call(Call.args, { a: Osargs.setExtent, x: 0x70, y: handle })).text).toBe(
                "File too big",
            );
        });

        it("will not load over the devices, or past the top of memory, but will load nothing anywhere", async () => {
            const t = hostWith([file("DATA", "xx"), file("EMPTY", "")]);
            expect(errorOf(await t.osfile(Osfile.load, "DATA", { load: 0xfc00 })).text).toBe("Bad address");
            expect(errorOf(await t.osfile(Osfile.load, "DATA", { load: 0xffff })).text).toBe("Bad address");
            expect(errorOf(await t.osfile(Osfile.load, "DATA", { load: 0x8000 }))).toBeUndefined();
            expect(errorOf(await t.osfile(Osfile.load, "EMPTY", { load: 0xfd00 }))).toBeUndefined();
        });

        it("will not run, or load at its own address, a file that has no addresses, which is any with no .inf", async () => {
            const t = hostWith([file("PLAIN", "xx")]);
            putString(t.cpu, Name, "PLAIN");
            expect(errorOf(await t.call(Call.fsc, { a: 4, ...xy(Name) })).text).toBe(
                "No load address (*SETINFO name load exec, or *LOAD name address)",
            );
            expect(errorOf(await t.osfile(Osfile.load, "PLAIN", { exec: 1 })).text).toBe(
                "No load address (*SETINFO name load exec, or *LOAD name address)",
            );
            expect(errorOf(await t.osfile(Osfile.load, "PLAIN", { load: Data }))).toBeUndefined();
        });
    });

    describe("when the store fails", () => {
        beforeEach(() => {
            vi.spyOn(console, "error").mockImplementation(() => {});
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("gives the BBC a disc fault, with the reason, for a store that cannot read or write", async () => {
            const t = hostWith([file("DATA", "x")]);
            t.store.read = async () => {
                throw new Error("EACCES: permission denied");
            };
            t.store.writeFile = async () => {
                throw new Error("ENOSPC: no space left");
            };
            expect(errorOf(await t.osfile(Osfile.load, "DATA", { load: Data })).text).toBe(
                "Disc fault: EACCES: permission denied",
            );
            expect(errorOf(await t.osfile(Osfile.save, "NEW", { start: Data, end: Data })).text).toBe(
                "Disc fault: ENOSPC: no space left",
            );
        });

        it("turns a failure of its own into an error on the 6502, cut short, instead of throwing into the emulator", async () => {
            const t = hostWith();
            t.cpu.peekmem = () => {
                throw new TypeError("x".repeat(500));
            };
            const error = errorOf(await t.call(Call.file, { a: Osfile.readInformation }));
            expect(error.text).toMatch(/^VDFS host failure/);
            expect(error.text.length).toBe(80);
        });

        it("says so, to whoever is listening, of a file that could not be written once the BBC has gone", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            t.store.writeFile = async () => {
                throw new Error("disc full");
            };
            t.host.onWriteFailure = vi.fn();
            t.host.reset();
            await t.host.flush();
            expect(t.host.onWriteFailure).toHaveBeenCalledWith(
                expect.objectContaining({ message: "Disc fault: disc full" }),
            );
        });
    });

    describe("a break while the host is busy", () => {
        it("answers nothing for a call that was waiting, and writes nothing into the machine", async () => {
            const t = hostWith([file("DATA", "HELLO", Program)]);
            let release;
            const gate = new Promise((resolve) => (release = resolve));
            const read = t.store.read.bind(t.store);
            t.store.read = async (path) => {
                await gate;
                return read(path);
            };
            putString(t.cpu, Name, "DATA");
            t.cpu.memory[Block] = Name & 0xff;
            t.cpu.memory[Block + 1] = Name >> 8;
            putLong(t.cpu, Block + 2, Data);
            for (const [port, value] of [
                [Port.a, Osfile.load],
                [Port.x, Block & 0xff],
                [Port.y, Block >> 8],
            ])
                t.host.write(port, value);
            t.host.write(Port.call, Call.file);
            await new Promise((resolve) => setImmediate(resolve));
            expect(t.host.read(Port.call)).toBe(Busy);
            t.host.reset();
            expect(t.host.read(Port.call)).toBe(0);
            release();
            await new Promise((resolve) => setImmediate(resolve));
            expect(t.cpu.memory.subarray(Data, Data + 5)).toEqual(new Uint8Array(5));
            expect(t.host.read(Port.call)).toBe(0);
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
        const exists = async (t, name) => (await t.osfile(Osfile.readInformation, name)).a;

        it("follows directories, the root, the parent, and the current and library directories", async () => {
            const t = hostWith(items);
            expect(await exists(t, "GAMES.ELITE")).toBe(1);
            expect(await exists(t, "$.GAMES.SUB.DEEP")).toBe(1);
            expect(await exists(t, ":0.$.TOP")).toBe(1);
            expect(await exists(t, "games.elite")).toBe(1);
            expect(await exists(t, "GAMES.^.TOP")).toBe(1);
            expect(await exists(t, "%.TOP")).toBe(1);
            expect(await exists(t, "@.TOP")).toBe(1);
            expect(await exists(t, "GAMES")).toBe(2);
        });

        it.each([
            ["a directory that is not there", "NOWHERE.A.NAME", "Not found"],
            ["a file where a directory should be", "TOP.X", "Not a directory"],
            ["a name that is too long", "ELEVENCHARS", "Bad name"],
            ["an empty part", "A..B", "Bad name"],
            ["a special directory in the middle", "GAMES.$.TOP", "Bad name"],
        ])("says what is wrong with %s", async (_, name, error) => {
            const t = hostWith(items);
            expect(errorOf(await t.osfile(Osfile.readInformation, name)).text).toBe(error);
        });

        it.each([["$.%"], ["$.&"], ["$.$"]])("will not make a file called %s", async (name) => {
            const t = hostWith();
            expect(errorOf(await t.open(name, Osfind.write)).text).toBe("Bad name");
        });

        it("sees a file added to the store after the machine started, with nothing to be done about it", async () => {
            const t = hostWith();
            expect((await t.osfile(Osfile.readInformation, "LATER")).a).toBe(0);
            t.store.writeFile(["LATER"], { data: Uint8Array.of(1), load: 0, exec: 0, locked: false });
            await new Promise((resolve) => setImmediate(resolve));
            expect((await t.osfile(Osfile.readInformation, "LATER")).a).toBe(1);
            expect(printed(await t.command("CAT"))).toContain("LATER");
        });
    });

    describe("open files", () => {
        it("reads a file a byte at a time, and says when it is at the end", async () => {
            const t = hostWith([file("DATA", "AB")]);
            const handle = (await t.open("DATA", Osfind.read)).a;
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

        it("raises EOF for a byte read past the end, which a pointer set beyond it makes", async () => {
            const t = hostWith([file("DATA", "AB")]);
            const handle = (await t.open("DATA", Osfind.read)).a;
            putLong(t.cpu, 0x70, 5);
            await t.call(Call.args, { a: Osargs.setPointer, x: 0x70, y: handle });
            expect(errorOf(await t.call(Call.bget, { y: handle })).text).toBe("EOF");
        });

        it("makes a file when it is opened for output, as a disc's catalogue does, and fills it as it is closed", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            expect(t.get("OUT").data.length).toBe(0);
            for (const byte of "hello") await t.call(Call.bput, { a: byte.charCodeAt(0), y: handle });
            expect(t.get("OUT").data.length).toBe(0);
            await t.call(Call.find, { a: Osfind.close, y: handle });
            expect(text(t.get("OUT").data)).toBe("hello");
        });

        it("empties a file that is opened for output, which was there", async () => {
            const t = hostWith([file("OUT", "old contents")]);
            await t.open("OUT", Osfind.write);
            expect(t.get("OUT").data.length).toBe(0);
        });

        it("hands over what is written on an OSARGS flush, for one file or for all, leaving it open", async () => {
            const t = hostWith();
            const first = (await t.open("ONE", Osfind.write)).a;
            const second = (await t.open("TWO", Osfind.write)).a;
            await t.call(Call.bput, { a: 1, y: first });
            await t.call(Call.bput, { a: 2, y: second });
            await t.call(Call.args, { a: Osargs.flush, y: first });
            expect([t.get("ONE").data.length, t.get("TWO").data.length]).toEqual([1, 0]);
            await t.call(Call.args, { a: Osargs.flush, y: 0 });
            expect(t.get("TWO").data.length).toBe(1);
            expect(errorOf(await t.call(Call.bput, { a: 3, y: first }))).toBeUndefined();
        });

        it("reports and sets the pointer and the extent", async () => {
            const t = hostWith([file("DATA", "ABCDEF")]);
            const handle = (await t.open("DATA", Osfind.update)).a;
            const argument = 0x70;
            const args = (a) => t.call(Call.args, { a, x: argument, y: handle });
            await args(Osargs.extent);
            expect(getLong(t.cpu, argument)).toBe(6);
            putLong(t.cpu, argument, 4);
            await args(Osargs.setPointer);
            expect((await t.call(Call.bget, { y: handle })).a).toBe("E".charCodeAt(0));
            await args(Osargs.pointer);
            expect(getLong(t.cpu, argument)).toBe(5);
            putLong(t.cpu, argument, 2);
            await args(Osargs.setExtent);
            await args(Osargs.extent);
            expect(getLong(t.cpu, argument)).toBe(2);
        });

        it("answers OSARGS for no file with the filing system's number", async () => {
            const t = hostWith();
            expect((await t.call(Call.args, { a: 0, y: 0 })).a).toBe(FilingSystemNumber);
        });

        it("gives 0 for a file that is not there, and an error for one that is a directory", async () => {
            const t = hostWith([directory("DIR")]);
            expect((await t.open("MISSING", Osfind.read)).a).toBe(0);
            expect(errorOf(await t.open("DIR", Osfind.read)).text).toBe("Is a directory");
        });

        it("will not open a locked file for update, but will for reading", async () => {
            const t = hostWith([file("KEEP", "x", { locked: true })]);
            expect(errorOf(await t.open("KEEP", Osfind.update)).text).toBe("Locked");
            expect((await t.open("KEEP", Osfind.read)).a).toBe(FirstHandle);
        });

        it("runs out of handles at the end of the range the filing system declared, before it empties a file", async () => {
            const t = hostWith([file("DATA", "x"), file("OUT", "keep")]);
            const range = await t.call(Call.fsc, { a: 7 });
            expect([range.x, range.y]).toEqual([FirstHandle, LastHandle]);
            for (let index = FirstHandle; index <= LastHandle; index++) await t.open("DATA", Osfind.read);
            expect(errorOf(await t.open("DATA", Osfind.read)).text).toBe("Too many open files");
            expect(errorOf(await t.open("OUT", Osfind.write)).text).toBe("Too many open files");
            expect(text(t.get("OUT").data)).toBe("keep");
        });

        it("says Channel for a handle that is not open", async () => {
            const t = hostWith();
            expect(errorOf(await t.call(Call.bget, { y: 0x15 })).text).toBe("Channel");
        });

        it("closes everything with a close of handle 0, keeping what was written", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            await t.call(Call.find, { a: Osfind.close, y: 0 });
            expect(text(t.get("OUT").data)).toBe("A");
            expect(errorOf(await t.call(Call.bget, { y: handle })).text).toBe("Channel");
        });

        it("writes what a break leaves open, since the files are closed by it", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            t.host.reset();
            await t.host.flush();
            expect(text(t.get("OUT").data)).toBe("A");
        });

        it("writes only a file that has been written to, and only once", async () => {
            const t = hostWith([file("READ", "x")]);
            const reading = (await t.open("READ", Osfind.read)).a;
            await t.call(Call.bget, { y: reading });
            await t.call(Call.find, { a: Osfind.close, y: 0 });
            expect(t.store.log).toEqual([]);
            const writing = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 1, y: writing });
            await t.host.flush();
            await t.host.flush();
            await t.call(Call.find, { a: Osfind.close, y: writing });
            expect(t.store.log).toEqual([
                ["writeFile", "OUT"],
                ["writeFile", "OUT"],
            ]);
        });

        it("will not write to, or change the extent of, a file that is open for reading", async () => {
            const t = hostWith([file("DATA", "ABC")]);
            const handle = (await t.open("DATA", Osfind.read)).a;
            gbpbBlock(t, { handle, count: 1 });
            putLong(t.cpu, 0x70, 1);
            const refusals = [
                await t.call(Call.bput, { a: 1, y: handle }),
                await gbpb(t, Osgbpb.write),
                await gbpb(t, Osgbpb.writeAtPointer),
                await t.call(Call.args, { a: Osargs.setExtent, x: 0x70, y: handle }),
            ];
            expect(refusals.map((result) => errorOf(result).text)).toEqual(["Locked", "Locked", "Locked", "Locked"]);
        });

        it("does not write a deleted file back when the channel that had it open is closed", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            await t.command("DELETE OUT");
            await t.call(Call.find, { a: Osfind.close, y: handle });
            expect(t.get("OUT")).toBeUndefined();
        });

        it("does not let the file an open channel had be written over what replaced it", async () => {
            const t = hostWith();
            const first = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: first });
            const second = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x42, y: second });
            await t.call(Call.find, { a: Osfind.close, y: second });
            await t.call(Call.find, { a: Osfind.close, y: first });
            expect(text(t.get("OUT").data)).toBe("B");
        });

        it("does not let one saved over an open file be written over by it", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            t.cpu.memory[Data] = 0x5a;
            await t.osfile(Osfile.save, "OUT", { start: Data, end: Data + 1 });
            await t.call(Call.find, { a: Osfind.close, y: handle });
            expect(text(t.get("OUT").data)).toBe("Z");
        });
    });

    describe("OSGBPB", () => {
        it("reads bytes from the pointer or from the one it is given, and says when it ran short", async () => {
            const t = hostWith([file("DATA", "ABCDEF")]);
            const handle = (await t.open("DATA", Osfind.read)).a;
            gbpbBlock(t, { handle, count: 4, pointer: 1 });
            expect((await gbpb(t, Osgbpb.readAtPointer)).p & Carry).toBe(0);
            expect(text(t.cpu.memory.subarray(Data, Data + 4))).toBe("BCDE");
            expect(getLong(t.cpu, Block + 9)).toBe(5);
            gbpbBlock(t, { handle, count: 4 });
            expect((await gbpb(t, Osgbpb.read)).p & Carry).toBe(Carry);
            expect(getLong(t.cpu, Block + 5)).toBe(3);
            expect(getLong(t.cpu, Block + 1)).toBe(Data + 1);
        });

        it("writes bytes, growing the file", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            t.cpu.memory.set(new TextEncoder().encode("abcdef"), Data);
            gbpbBlock(t, { handle, count: 6 });
            await gbpb(t, Osgbpb.writeAtPointer);
            gbpbBlock(t, { handle, count: 3, pointer: 2 });
            await gbpb(t, Osgbpb.writeAtPointer);
            await t.call(Call.find, { a: Osfind.close, y: handle });
            expect(text(t.get("OUT").data)).toBe("ababcf");
        });

        it("leaves the pointer where it was when the memory it was to fill is not there", async () => {
            const t = hostWith([file("DATA", "ABCDEF")]);
            const handle = (await t.open("DATA", Osfind.read)).a;
            gbpbBlock(t, { handle, address: 0xfc00, count: 2 });
            expect(errorOf(await gbpb(t, Osgbpb.read)).text).toBe("Bad address");
            gbpbBlock(t, { handle, count: 2 });
            await gbpb(t, Osgbpb.read);
            expect(text(t.cpu.memory.subarray(Data, Data + 2))).toBe("AB");
        });

        it("says what it does not do", async () => {
            const t = hostWith();
            expect(errorOf(await gbpb(t, 5)).text).toMatch(/not supported/);
        });
    });

    describe("filing system commands", () => {
        const items = [directory("GAMES"), file("GAMES.ELITE", "elite", Program), file("TOP", "top", { locked: true })];

        it("lists the directory the *CAT names, or the current one", async () => {
            const t = hostWith(items);
            putString(t.cpu, Name, "");
            const listing = printed(await t.call(Call.fsc, { a: 5, ...xy(Name) }));
            expect(listing).toContain("Dir. $  Lib. $");
            expect(listing).toContain("GAMES     D");
            expect(listing).toContain("TOP       L");
            putString(t.cpu, Name, "GAMES");
            expect(printed(await t.call(Call.fsc, { a: 5, ...xy(Name) }))).toContain("ELITE");
        });

        it("lists three to a line, so a directory of many fits MODE 7", async () => {
            const t = hostWith(["A", "B", "C", "D", "E"].map((name) => file(name)));
            putString(t.cpu, Name, "");
            const lines = printed(await t.call(Call.fsc, { a: 5, ...xy(Name) })).split("\r");
            expect(lines.slice(3, 5).map((line) => line.length)).toEqual([39, 26]);
        });

        it("says how many files it cannot show, and names a few, since they are not there to the BBC", async () => {
            const t = hostWith([file("OK")]);
            t.store.skipped = ["A LONG FILE NAME.bas", "my game", "tést", "fourth"];
            putString(t.cpu, Name, "");
            const listing = printed(await t.call(Call.fsc, { a: 5, ...xy(Name) }));
            expect(listing).toContain(
                "4 not shown: the BBC cannot name A LONG FILE NAME.bas, my game, t?st and more\r",
            );
        });

        it("changes directory with *DIR, and the library with *LIB", async () => {
            const t = hostWith(items);
            await t.command("DIR GAMES");
            expect((await t.osfile(Osfile.readInformation, "ELITE")).a).toBe(1);
            await t.command("DIR");
            expect((await t.osfile(Osfile.readInformation, "ELITE")).a).toBe(0);
            await t.command("LIB GAMES");
            expect(printed(await t.command("INFO"))).toContain("GAMES");
            expect(errorOf(await t.command("DIR TOP")).text).toBe("Not a directory");
        });

        it("shows *INFO with wildcards, and *EX of the whole directory", async () => {
            const t = hostWith(items);
            expect(printed(await t.command("INFO T*"))).toBe("TOP        L 00000000 00000000 000003\r");
            expect(printed(await t.command("EX GAMES.*"))).toContain("ELITE");
            expect(errorOf(await t.command("INFO NOPE*")).text).toBe("Not found");
        });

        it("creates, deletes and locks, leaving what a file holds as it was", async () => {
            const t = hostWith(items);
            await t.command("CDIR NEW");
            await t.command("ACCESS GAMES.ELITE L");
            expect(errorOf(await t.command("DELETE GAMES.ELITE")).text).toBe("Locked");
            await t.command("ACCESS GAMES.ELITE");
            await t.command("DELETE GAMES.ELITE");
            expect(t.store.log).toEqual([
                ["makeDirectory", "NEW"],
                ["setInfo", "GAMES.ELITE"],
                ["setInfo", "GAMES.ELITE"],
                ["remove", "GAMES.ELITE"],
            ]);
            expect(errorOf(await t.command("CDIR NEW")).text).toBe("Already exists");
        });

        it("sets a file's addresses with *SETINFO, and leaves exec alone if it is left out", async () => {
            const t = hostWith([file("PLAIN", "x"), directory("DIR")]);
            await t.command("SETINFO PLAIN &2000 2005");
            expect(t.get("PLAIN")).toMatchObject({ load: 0x2000, exec: 0x2005 });
            await t.command("SETINFO PLAIN 3000");
            expect(t.get("PLAIN")).toMatchObject({ load: 0x3000, exec: 0x2005 });
            expect(errorOf(await t.command("SETINFO PLAIN XYZ")).text).toBe("Bad address");
            expect(errorOf(await t.command("SETINFO PLAIN")).text).toBe("Bad address");
            expect(errorOf(await t.command("SETINFO DIR 2000")).text).toBe("Access violation");
            expect(errorOf(await t.command("SETINFO NOPE 2000")).text).toBe("Not found");
        });

        it.each([
            ["SETINFO PLAIN ffffffff", undefined, 0xffffffff],
            ["SETINFO PLAIN 123456789", "Bad address", 0],
            ["SETINFO PLAIN &", "Bad address", 0],
            ["SETINFO LOCKED 2000", "Locked", 0],
            ["SETINFO PLAIN 2000 2000", undefined, 0x2000],
        ])("*%s gives %s", async (line, error, load) => {
            const t = hostWith([file("PLAIN", "x"), file("LOCKED", "x", { locked: true })]);
            expect(errorOf(await t.command(line))?.text).toBe(error);
            expect(t.get("PLAIN").load).toBe(load);
        });

        it("runs a file once *SETINFO has given it an exec address", async () => {
            const t = hostWith([file("PLAIN", "x")]);
            await t.command("SETINFO PLAIN 2000 2005");
            putString(t.cpu, Name, "PLAIN");
            const run = await t.call(Call.fsc, { a: 4, ...xy(Name) });
            expect(run.ops).toContainEqual({ op: "exec", address: 0x2005 });
            expect(t.cpu.memory[0x2000]).toBe("x".charCodeAt(0));
        });

        it.each([["CDIR"], ["DELETE"], ["ACCESS"], ["SETINFO"]])("says Bad name for *%s with no name", async (name) => {
            const t = hostWith(items);
            expect(errorOf(await t.command(name)).text).toBe("Bad name");
        });

        it("will not delete a directory that has something in it, or the root", async () => {
            const t = hostWith(items);
            expect(errorOf(await t.command("DELETE GAMES")).text).toBe("Dir not empty");
            expect(errorOf(await t.osfile(Osfile.delete, "$")).text).toBe("Access violation");
        });

        it("goes back to the root when the directory or library it is in is deleted", async () => {
            const t = hostWith([directory("D"), directory("L")]);
            await t.command("DIR D");
            await t.command("LIB L");
            await t.command("DELETE $.D");
            await t.command("DELETE $.L");
            expect(printed(await t.command("CAT"))).toContain("Dir. $  Lib. $");
        });

        it("runs a file: loading it where it says and handing the ROM its exec address", async () => {
            const t = hostWith(items);
            expect((await t.command("GAMES.ELITE")).ops).toEqual([{ op: "exec", address: 0x1900 }]);
            expect(text(t.cpu.memory.subarray(0x1900, 0x1905))).toBe("elite");
            putString(t.cpu, Name, "GAMES.ELITE");
            expect((await t.call(Call.fsc, { a: 4, ...xy(Name) })).ops).toEqual([{ op: "exec", address: 0x1900 }]);
        });

        it("runs a file from the library when it is not in the current directory", async () => {
            const t = hostWith(items);
            await t.command("LIB GAMES");
            expect((await t.command("ELITE")).ops).toEqual([{ op: "exec", address: 0x1900 }]);
        });

        it("will not run a directory, or a file on a machine whose exec address is not the I/O processor's", async () => {
            const t = hostWith(items);
            expect(errorOf(await t.command("GAMES")).text).toBe("Is a directory");
            const tube = hostWith([file("PROG", "x", { load: 0xffff1900, exec: 0x1900 })], { hasTube: true });
            expect(errorOf(await tube.command("PROG")).text).toMatch(/Tube/);
        });

        it("says Bad command for a name that is neither a command nor a file", async () => {
            const t = hostWith(items);
            expect(errorOf(await t.command("FOO"))).toEqual({ op: "error", number: 0xfe, text: "Bad command" });
            expect(errorOf(await t.command("NO.SUCH.THING")).text).toBe("Bad command");
        });
    });

    describe("service calls", () => {
        it("claims *VDFS, selecting the filing system, and leaves other commands alone", async () => {
            const t = hostWith();
            const selected = await t.service(4, { line: "VDFS" });
            expect(selected.ops).toEqual([{ op: "claim" }]);
            expect(selected.a).toBe(0);
            expect(t.host.selected).toBe(true);
            expect((await t.service(4, { line: "NOPE" })).a).toBe(4);
        });

        it("answers the selection of its filing system number, and not another's", async () => {
            const t = hostWith();
            expect((await t.service(0x12, { y: 4 })).ops).toEqual([]);
            const selected = await t.service(0x12, { y: FilingSystemNumber });
            expect(selected.ops).toEqual([{ op: "claim" }]);
            expect(selected.a).toBe(0);
        });

        it("takes over a command, such as *DIR, ahead of other filing systems once it is selected", async () => {
            const t = hostWith([directory("GAMES"), file("GAMES.ELITE")]);
            expect((await t.service(4, { line: "DIR GAMES" })).a).toBe(4);
            await t.service(4, { line: "VDFS" });
            expect((await t.service(4, { line: "DIR GAMES" })).a).toBe(0);
            expect(printed(await t.command("CAT"))).toContain("ELITE");
        });

        it("stops being the selected filing system when another is chosen, but not by its own reselection", async () => {
            const t = hostWith();
            await t.service(4, { line: "VDFS" });
            await t.call(Call.fsc, { a: 6 });
            expect(t.host.selected).toBe(false);
            await t.service(4, { line: "VDFS" });
            await t.service(4, { line: "VDFS" });
            await t.call(Call.fsc, { a: 6 });
            expect(t.host.selected).toBe(true);
        });

        it("writes what is open, and closes it, when another filing system is chosen", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            await t.call(Call.fsc, { a: 6 });
            expect(text(t.get("OUT").data)).toBe("A");
            expect(errorOf(await t.call(Call.bget, { y: handle })).text).toBe("Channel");
        });

        it("introduces itself under *HELP, and lists its commands, sorted, under *HELP VDFS", async () => {
            const t = hostWith();
            const help = await t.service(9);
            expect(help.ops).toEqual([{ op: "print", text: "  VDFS 0.1\r" }]);
            expect(help.a).toBe(9);
            const lines = (await t.service(9, { line: "VDFS" })).ops[0].text.split("\r");
            expect(lines.slice(0, 3)).toEqual(["VDFS 0.1", "  ACCESS <afsp> (L)", "  CAT (<dir>)"]);
            expect(lines.filter((line) => line.trim() === "VDFS")).toEqual(["  VDFS"]);
            expect(lines.at(-2)).toBe("  VDFS");
            expect((await t.service(9, { line: "OTHER" })).ops).toEqual([]);
        });

        it("lists every command it has under *HELP VDFS, each once, in order", async () => {
            const t = hostWith();
            const listed = (await t.service(9, { line: "VDFS" })).ops[0].text
                .split("\r")
                .slice(1, -1)
                .map((line) => line.trim().split(" ")[0]);
            expect(listed).toEqual(["ACCESS", "CAT", "CDIR", "DELETE", "DIR", "EX", "INFO", "LIB", "SETINFO", "VDFS"]);
        });
    });

    describe("writing files back", () => {
        it("keeps every file open, to be written again, when one cannot be written as they are all closed", async () => {
            const t = hostWith();
            const [first, second] = [(await t.open("ONE", Osfind.write)).a, (await t.open("TWO", Osfind.write)).a];
            await t.call(Call.bput, { a: 1, y: first });
            await t.call(Call.bput, { a: 2, y: second });
            const writeFile = t.store.writeFile.bind(t.store);
            let failing = true;
            t.store.writeFile = async (path, details) => {
                if (failing) throw new Error("disc full");
                return writeFile(path, details);
            };
            expect(errorOf(await t.call(Call.find, { a: Osfind.close, y: 0 })).text).toBe("Disc fault: disc full");
            failing = false;
            await t.host.flush();
            expect([t.get("ONE").data.length, t.get("TWO").data.length]).toEqual([1, 1]);
        });

        it("keeps a file open when it cannot be written as it is closed, so that closing it again can", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 1, y: handle });
            const writeFile = t.store.writeFile.bind(t.store);
            t.store.writeFile = async () => {
                throw new Error("disc full");
            };
            expect(errorOf(await t.call(Call.find, { a: Osfind.close, y: handle })).text).toMatch(/Disc fault/);
            t.store.writeFile = writeFile;
            await t.call(Call.find, { a: Osfind.close, y: handle });
            expect(t.get("OUT").data.length).toBe(1);
        });

        it("makes a call wait for a flush that is under way, and writes what the BBC adds after it, when it is closed", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            const writeFile = t.store.writeFile.bind(t.store);
            let release;
            const gate = new Promise((resolve) => (release = resolve));
            t.store.writeFile = async (path, details) => {
                await gate;
                return writeFile(path, details);
            };
            const flushing = t.host.flush();
            const putting = t.call(Call.bput, { a: 0x42, y: handle });
            await new Promise((resolve) => setImmediate(resolve));
            expect(t.host.read(Port.call)).toBe(Busy);
            release();
            await flushing;
            await putting;
            t.store.writeFile = writeFile;
            await t.call(Call.find, { a: Osfind.close, y: handle });
            expect(text(t.get("OUT").data)).toBe("AB");
        });

        it("makes a call made after a break wait for the files the break wrote, so that it sees them", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            t.host.reset();
            await t.osfile(Osfile.readInformation, "OUT");
            expect(getLong(t.cpu, Block + 10)).toBe(1);
        });
    });

    describe("a folder that is about to change", () => {
        it("does not make a call wait after a break when there is nothing to write", () => {
            const t = hostWith([file("DATA", "x")]);
            t.host.reset();
            for (const [port, value] of [
                [Port.a, 0],
                [Port.x, 0],
                [Port.y, 0],
            ])
                t.host.write(port, value);
            t.host.write(Port.call, Call.bget);
            expect(t.host.read(Port.call)).toBe(0);
        });

        it("goes on after being held twice, and when a failure cannot be reported", async () => {
            const t = hostWith([file("DATA", "x")]);
            await t.host.hold();
            await t.host.hold();
            t.host.release();
            t.host.onWriteFailure = () => {
                throw new Error("nobody to tell");
            };
            const writing = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: writing });
            t.store.writeFile = async () => {
                throw new Error("disc full");
            };
            const errors = vi.spyOn(console, "error").mockImplementation(() => {});
            await t.host.closeAll();
            expect(errors).toHaveBeenCalled();
            errors.mockRestore();
            expect(errorOf(await t.osfile(Osfile.readInformation, "DATA"))).toBeUndefined();
        });

        it("ends the call that is waiting with Disc changed, writes what is open to the folder it came from, and waits", async () => {
            const t = hostWith([file("DATA", "HELLO")]);
            const writing = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: writing });
            let release;
            const gate = new Promise((resolve) => (release = resolve));
            const find = t.store.find.bind(t.store);
            t.store.find = async (...args) => {
                await gate;
                return find(...args);
            };
            const pending = t.osfile(Osfile.readInformation, "DATA");
            await new Promise((resolve) => setImmediate(resolve));
            await t.host.hold();
            expect(errorOf(await pending).text).toBe("Disc changed");
            release();
            t.host.release();
            expect(text(t.get("OUT").data)).toBe("A");
            expect(errorOf(await t.call(Call.bget, { y: writing })).text).toBe("Channel");
        });

        it("makes the calls that come while it is held go to the new folder, once it is released", async () => {
            const t = hostWith([file("OLD", "x")]);
            await t.host.hold();
            putString(t.cpu, Name, "NEW");
            t.cpu.memory[Block] = Name & 0xff;
            t.cpu.memory[Block + 1] = Name >> 8;
            for (const [port, value] of [
                [Port.a, Osfile.readInformation],
                [Port.x, Block & 0xff],
                [Port.y, Block >> 8],
            ])
                t.host.write(port, value);
            t.host.write(Port.call, Call.file);
            await new Promise((resolve) => setImmediate(resolve));
            expect(t.host.read(Port.call)).toBe(Busy);
            t.host.store = new MemoryStore([file("NEW", "abc")]);
            t.host.release();
            await new Promise((resolve) => setImmediate(resolve));
            expect(t.host.read(Port.call)).toBe(0);
            t.host.write(Port.stream, t.host.read(Port.stream));
            expect(getLong(t.cpu, Block + 10)).toBe(3);
        });
    });

    describe("what the BBC waits for", () => {
        it.each([
            ["OSBGET", () => ({ call: Call.bget, registers: { y: FirstHandle } })],
            ["OSBPUT", () => ({ call: Call.bput, registers: { y: FirstHandle, a: 1 } })],
            [
                "OSARGS for the pointer",
                () => ({ call: Call.args, registers: { a: Osargs.pointer, x: 0x70, y: FirstHandle } }),
            ],
            ["OSARGS for the filing system", () => ({ call: Call.args, registers: { a: 0, y: 0 } })],
            ["a check for the end of a file", () => ({ call: Call.fsc, registers: { a: 1, x: FirstHandle } })],
            ["a request for the range of handles", () => ({ call: Call.fsc, registers: { a: 7 } })],
            ["a service call it does not take", () => ({ call: Call.service, registers: { a: 0x0f } })],
            ["a command it is not asked to run", () => ({ call: Call.service, registers: { a: 4 } })],
            [
                "a close of a file that has not been written to",
                () => ({ call: Call.find, registers: { a: 0, y: FirstHandle } }),
            ],
        ])("is nothing, for %s, which does not use the store", async (_, make) => {
            const t = hostWith([file("DATA", "x")]);
            await t.open("DATA", Osfind.read);
            const { call, registers } = make();
            for (const [port, value] of Object.entries({ a: 0, x: 0, y: 0, p: 0, ...registers }))
                t.host.write(Port[port], value);
            t.host.write(Port.call, call);
            expect(t.host.read(Port.call)).toBe(0);
        });

        it("is the store, for a call that uses it", async () => {
            const t = hostWith([file("DATA", "x")]);
            putString(t.cpu, Name, "DATA");
            for (const [port, value] of Object.entries({
                a: Osfind.read,
                ...Object.fromEntries(Object.entries(xy(Name))),
            }))
                t.host.write(Port[port], value);
            t.host.write(Port.call, Call.find);
            expect(t.host.read(Port.call)).toBe(Busy);
        });

        it("is a disc fault, with the reason and not the IPC's wrapping of it, when the main process's store fails", async () => {
            const t = hostWith([file("DATA", "x")]);
            t.store.read = async () => {
                throw new Error("Error invoking remote method 'vdfs-read': Error: EACCES: permission denied");
            };
            expect(errorOf(await t.osfile(Osfile.load, "DATA", { load: Data })).text).toBe(
                "Disc fault: EACCES: permission denied",
            );
        });

        it("is the disc fault, and not Bad command or File not found, when the store fails while a file is looked for to run", async () => {
            const t = hostWith([file("PROG", "x", Program)]);
            t.store.find = async () => {
                throw new Error("EIO");
            };
            expect(errorOf(await t.command("PROG")).text).toBe("Disc fault: EIO");
        });
    });

    describe("the store it serves", () => {
        it("is told to close everything, and the current directory and library are the root's, when it is to change", async () => {
            const t = hostWith([directory("D")]);
            await t.command("DIR D");
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            await t.host.closeAll();
            expect(text(t.get("D.OUT")?.data ?? new Uint8Array())).toBe("A");
            expect(errorOf(await t.call(Call.bget, { y: handle })).text).toBe("Channel");
            expect(printed(await t.command("CAT"))).toContain("Dir. $  Lib. $");
        });

        it("hands over what is written, open files included, on a flush, and leaves them open", async () => {
            const t = hostWith();
            const handle = (await t.open("OUT", Osfind.write)).a;
            await t.call(Call.bput, { a: 0x41, y: handle });
            await t.host.flush();
            expect(text(t.get("OUT").data)).toBe("A");
            expect(errorOf(await t.call(Call.bput, { a: 0x42, y: handle }))).toBeUndefined();
        });

        it("keeps nothing of a response across a break", async () => {
            const t = hostWith();
            t.host.write(Port.call, Call.args);
            await new Promise((resolve) => setImmediate(resolve));
            expect(t.host.openStreams).toBe(1);
            t.host.reset();
            expect(t.host.openStreams).toBe(0);
        });

        it("may be a store of any kind that has the calls", async () => {
            expect(() => hostWith([], { store: new MemoryStore() })).not.toThrow();
        });
    });
});
