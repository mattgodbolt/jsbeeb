import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsStore, formatInf, parseInf } from "../../src/vdfs-fs-store.js";

const written = (data = [1], extra = {}) => ({
    data: Uint8Array.from(data),
    load: 0,
    exec: 0,
    locked: false,
    ...extra,
});

describe("VDFS folder store", () => {
    let outside;
    let root;
    let store;

    beforeEach(async () => {
        outside = await fs.mkdtemp(path.join(os.tmpdir(), "vdfs-store-"));
        root = path.join(outside, "volume");
        await fs.mkdir(root);
        store = new FsStore(root);
    });

    afterEach(() => fs.rm(outside, { recursive: true, force: true }));

    describe(".inf files", () => {
        it.each([
            ["$.MENU  FFFF1900 FFFF8023 00000A00\n", { load: 0xffff1900, exec: 0xffff8023, locked: false }],
            ["MENU 1900 8023", { load: 0x1900, exec: 0x8023, locked: false }],
            ["$.MENU  1900 8023 A00 L", { load: 0x1900, exec: 0x8023, locked: true }],
            ["$.MENU  1900 8023 A00 Locked", { load: 0x1900, exec: 0x8023, locked: true }],
            ["$.MENU  1900 8023 A00 08", { load: 0x1900, exec: 0x8023, locked: true }],
            ["$.MENU  1900 8023 A00 CRC=1234", { load: 0x1900, exec: 0x8023, locked: false }],
            ["$.MENU", { load: 0, exec: 0, locked: false }],
            ["", { load: 0, exec: 0, locked: false }],
            ["$.MENU  zzzz yyyy", { load: 0, exec: 0, locked: false }],
        ])("reads %j", (text, expected) => {
            expect(parseInf(text)).toEqual(expected);
        });

        it("writes what it reads", () => {
            const line = formatInf("MENU", { load: 0xffff1900, exec: 0xffff8023, locked: true, length: 0xa00 });
            expect(line).toBe("$.MENU  FFFF1900 FFFF8023 00000A00 L\n");
            expect(parseInf(line)).toEqual({ load: 0xffff1900, exec: 0xffff8023, locked: true });
        });
    });

    describe("the folder", () => {
        it("is checked to be there", async () => {
            await expect(store.check()).resolves.toBeUndefined();
            await expect(new FsStore(path.join(outside, "nowhere")).check()).rejects.toThrow();
            await fs.writeFile(path.join(outside, "file"), "x");
            await expect(new FsStore(path.join(outside, "file")).check()).rejects.toThrow("not a folder");
        });
    });

    describe("finding", () => {
        it("says what is there, with the addresses and lock its .inf file gives", async () => {
            await fs.writeFile(path.join(root, "MENU"), "data");
            await fs.writeFile(path.join(root, "MENU.inf"), "$.MENU 1900 8023 4 L");
            await fs.mkdir(path.join(root, "GAMES"));
            expect(await store.find([], "MENU")).toEqual({
                name: "MENU",
                isDirectory: false,
                size: 4,
                load: 0x1900,
                exec: 0x8023,
                locked: true,
            });
            expect(await store.find([], "GAMES")).toMatchObject({ name: "GAMES", isDirectory: true });
        });

        it("matches the name whatever the case, and gives it as the folder spells it", async () => {
            await fs.writeFile(path.join(root, "Menu"), "x");
            expect((await store.find([], "MENU")).name).toBe("Menu");
            expect((await store.find([], "menu")).name).toBe("Menu");
        });

        it("looks in a directory, and gives nothing for what is not there, or for a directory that is not", async () => {
            await fs.mkdir(path.join(root, "GAMES"));
            await fs.writeFile(path.join(root, "GAMES", "ELITE"), "x");
            expect(await store.find(["GAMES"], "ELITE")).toMatchObject({ name: "ELITE" });
            expect(await store.find(["GAMES"], "NOPE")).toBeNull();
            expect(await store.find(["NOWHERE"], "ELITE")).toBeNull();
            expect(await store.find(["GAMES", "ELITE"], "X")).toBeNull();
        });

        it("shows a dot in a host name as a slash", async () => {
            await fs.writeFile(path.join(root, "prog.bas"), "x");
            expect(await store.find([], "prog/bas")).toMatchObject({ name: "prog/bas" });
        });

        it("does not show a .inf file as a file, whatever the case of its suffix", async () => {
            await fs.writeFile(path.join(root, "A"), "x");
            await fs.writeFile(path.join(root, "A.INF"), "$.A 1900 1900");
            expect(await store.find([], "A/INF")).toBeNull();
            expect((await store.list([])).entries.map((entry) => entry.name)).toEqual(["A"]);
        });

        it("does not follow a symbolic link out of the folder, or read a .inf file that is one", async () => {
            await fs.writeFile(path.join(outside, "secret"), "$.B FFFF FFFF");
            await fs.symlink(path.join(outside, "secret"), path.join(root, "LINK"));
            await fs.symlink(outside, path.join(root, "DIRLINK"));
            await fs.writeFile(path.join(root, "B"), "x");
            await fs.symlink(path.join(outside, "secret"), path.join(root, "B.inf"));
            expect(await store.find([], "LINK")).toBeNull();
            expect(await store.find([], "DIRLINK")).toBeNull();
            expect((await store.find([], "B")).load).toBe(0);
        });
    });

    describe("listing", () => {
        it("gives every file and directory, with what is known of each, and nothing for a directory that is not there", async () => {
            await fs.writeFile(path.join(root, "B"), "xy");
            await fs.writeFile(path.join(root, "A"), "x");
            await fs.mkdir(path.join(root, "C"));
            const { entries, skipped } = await store.list([]);
            expect(entries.map(({ name, isDirectory, size }) => [name, isDirectory, size])).toEqual([
                ["A", false, 1],
                ["B", false, 2],
                ["C", true, 0],
            ]);
            expect(skipped).toEqual([]);
            expect(await store.list(["NOWHERE"])).toBeNull();
        });

        it("names what the 6502 could not, so that it can be told", async () => {
            await fs.writeFile(path.join(root, "WAY-TOO-LONG-A-NAME"), "x");
            await fs.writeFile(path.join(root, "a#b"), "x");
            await fs.writeFile(path.join(root, "my game"), "x");
            await fs.writeFile(path.join(root, "OK"), "x");
            const { entries, skipped } = await store.list([]);
            expect(entries.map((entry) => entry.name)).toEqual(["OK"]);
            expect(skipped.sort()).toEqual(["WAY-TOO-LONG-A-NAME", "a#b", "my game"]);
        });
    });

    describe("reading", () => {
        it("gives a file's bytes, and will not read through a symbolic link", async () => {
            await fs.writeFile(path.join(root, "F"), Uint8Array.of(1, 2, 3));
            expect([...(await store.read(["F"]))]).toEqual([1, 2, 3]);
            await fs.writeFile(path.join(outside, "secret"), "s");
            await fs.symlink(path.join(outside, "secret"), path.join(root, "LINK"));
            await expect(store.read(["LINK"])).rejects.toThrow(/symbolic link/);
        });
    });

    describe("writing", () => {
        it("writes a file with a .inf file beside it when it has addresses, and none when it has not", async () => {
            await store.writeFile(["GAME"], written([1, 2], { load: 0x1900, exec: 0x1900 }));
            await store.writeFile(["PLAIN"], written([3]));
            expect([...(await fs.readFile(path.join(root, "GAME")))]).toEqual([1, 2]);
            expect(await fs.readFile(path.join(root, "GAME.inf"), "utf8")).toBe("$.GAME  00001900 00001900 00000002\n");
            expect((await fs.readdir(root)).sort()).toEqual(["GAME", "GAME.inf", "PLAIN"]);
        });

        it("drops a .inf file that has become unneeded", async () => {
            await store.writeFile(["F"], written([1], { load: 5 }));
            await store.writeFile(["F"], written([1]));
            expect(await fs.readdir(root)).toEqual(["F"]);
        });

        it("changes a file's addresses or lock and leaves what it holds, and the rest of what its .inf file said", async () => {
            await store.writeFile(["F"], written([1, 2], { load: 0x1900, exec: 0x1901 }));
            await store.setInfo(["F"], { locked: true });
            expect(await store.find([], "F")).toMatchObject({ size: 2, load: 0x1900, exec: 0x1901, locked: true });
            await store.setInfo(["F"], { exec: 0x2000 });
            expect(await store.find([], "F")).toMatchObject({ load: 0x1900, exec: 0x2000, locked: true });
            expect([...(await fs.readFile(path.join(root, "F")))]).toEqual([1, 2]);
            await store.setInfo(["F"], { load: 0, exec: 0, locked: false });
            expect(await fs.readdir(root)).toEqual(["F"]);
        });

        it("makes directories, puts files in them, and removes them again", async () => {
            await store.makeDirectory(["GAMES"]);
            await store.writeFile(["GAMES", "ELITE"], written());
            expect(await fs.readdir(path.join(root, "GAMES"))).toEqual(["ELITE"]);
            await store.remove(["GAMES", "ELITE"]);
            await store.remove(["GAMES"]);
            expect(await fs.readdir(root)).toEqual([]);
        });

        it("removes a file's .inf file with it", async () => {
            await store.writeFile(["F"], written([1], { load: 5 }));
            await store.remove(["F"]);
            expect(await fs.readdir(root)).toEqual([]);
        });

        it("writes a name with a slash in it as a dot", async () => {
            await store.writeFile(["prog/bas"], written());
            expect(await fs.readdir(root)).toEqual(["prog.bas"]);
        });

        it("replaces a file saved under another case of its name, on a host that tells them apart", async () => {
            await store.writeFile(["ABC"], written([1], { load: 5 }));
            await store.writeFile(["abc"], written([2], { load: 5 }));
            expect((await fs.readdir(root)).sort()).toEqual(["abc", "abc.inf"]);
            expect([...(await fs.readFile(path.join(root, "abc")))]).toEqual([2]);
        });
    });

    describe("staying in the folder", () => {
        it.each([["/"], ["//"]])("will not write to %j, which is a dot or two as a host name", async (name) => {
            await expect(store.writeFile([name], written())).rejects.toThrow();
            expect(await fs.readdir(outside)).toEqual(["volume"]);
        });

        it("will not write through a symbolic link, to a file, a directory, or a .inf file", async () => {
            const target = path.join(outside, "target");
            await fs.writeFile(target, "keep");
            await fs.symlink(target, path.join(root, "LINK"));
            await fs.symlink(target, path.join(root, "GAME.inf"));
            await fs.mkdir(path.join(outside, "elsewhere"));
            await fs.symlink(path.join(outside, "elsewhere"), path.join(root, "DIR"));
            await expect(store.writeFile(["LINK"], written())).rejects.toThrow(/symbolic link/);
            await expect(store.writeFile(["GAME"], written([1], { load: 0x1900 }))).rejects.toThrow(/symbolic link/);
            await expect(store.writeFile(["DIR", "F"], written())).rejects.toThrow(/outside/);
            await expect(store.setInfo(["GAME"], { locked: true })).rejects.toThrow();
            expect(await fs.readFile(target, "utf8")).toBe("keep");
            expect(await fs.readdir(path.join(outside, "elsewhere"))).toEqual([]);
        });
    });
});
