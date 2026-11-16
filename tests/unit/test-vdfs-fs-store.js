import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsStore, formatInf, parseInf, toBbcName } from "../../src/vdfs-fs-store.js";
import { VdfsVolume } from "../../src/vdfs-volume.js";

describe("VDFS folder store", () => {
    let outside;
    let root;

    beforeEach(async () => {
        outside = await fs.mkdtemp(path.join(os.tmpdir(), "vdfs-store-"));
        root = path.join(outside, "volume");
        await fs.mkdir(root);
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

    describe("loading", () => {
        it("reads files, their .inf files, and directories, hiding the .inf files themselves", async () => {
            await fs.writeFile(path.join(root, "MENU"), "data");
            await fs.writeFile(path.join(root, "MENU.inf"), "$.MENU 1900 8023");
            await fs.mkdir(path.join(root, "GAMES"));
            await fs.writeFile(path.join(root, "GAMES", "ELITE"), "elite");
            const volume = await VdfsVolume.open(new FsStore(root));
            const menu = volume.root.children.get("MENU");
            expect([menu.load, menu.exec, menu.length]).toEqual([0x1900, 0x8023, 4]);
            expect(volume.root.children.has("MENU/INF")).toBe(false);
            expect(volume.root.children.get("GAMES").children.get("ELITE").length).toBe(5);
        });

        it("shows a dot in a host name as a slash, and leaves out what the 6502 could not name", async () => {
            await fs.writeFile(path.join(root, "prog.bas"), "x");
            await fs.writeFile(path.join(root, "WAY-TOO-LONG-A-NAME"), "x");
            await fs.writeFile(path.join(root, "a#b"), "x");
            const volume = await VdfsVolume.open(new FsStore(root));
            expect([...volume.root.children.values()].map((entry) => entry.name)).toEqual(["prog/bas"]);
            expect(toBbcName("prog.bas")).toBe("prog/bas");
        });

        it("leaves out a .inf file whatever the case of its suffix, and ignores one that is a link", async () => {
            await fs.writeFile(path.join(root, "A"), "x");
            await fs.writeFile(path.join(root, "A.INF"), "$.A 1900 1900");
            await fs.writeFile(path.join(outside, "secret"), "$.A FFFF FFFF");
            await fs.writeFile(path.join(root, "B"), "x");
            await fs.symlink(path.join(outside, "secret"), path.join(root, "B.inf"));
            const volume = await VdfsVolume.open(new FsStore(root));
            expect([...volume.root.children.keys()]).toEqual(["A", "B"]);
            expect(volume.root.children.get("B").load).toBe(0);
        });

        it("does not follow a symbolic link out of the folder", async () => {
            await fs.writeFile(path.join(outside, "secret"), "secret");
            await fs.symlink(path.join(outside, "secret"), path.join(root, "LINK"));
            await fs.symlink(outside, path.join(root, "DIRLINK"));
            const volume = await VdfsVolume.open(new FsStore(root));
            expect(volume.root.children.size).toBe(0);
        });
    });

    describe("saving", () => {
        const make = async () => {
            const volume = await VdfsVolume.open(new FsStore(root));
            return volume;
        };

        it("writes a file with a .inf file beside it when it has addresses, and none when it has not", async () => {
            const volume = await make();
            volume.persist(
                volume.createFile(volume.root, "GAME", { load: 0x1900, exec: 0x1900, data: Uint8Array.of(1, 2) }),
            );
            volume.persist(volume.createFile(volume.root, "PLAIN", { data: Uint8Array.of(3) }));
            await volume.flush();
            expect([...(await fs.readFile(path.join(root, "GAME")))]).toEqual([1, 2]);
            expect(await fs.readFile(path.join(root, "GAME.inf"), "utf8")).toBe("$.GAME  00001900 00001900 00000002\n");
            expect(await fs.readdir(root)).toEqual(["GAME", "GAME.inf", "PLAIN"]);
        });

        it("drops a .inf file that has become unneeded", async () => {
            const volume = await make();
            const entry = volume.createFile(volume.root, "F", { load: 5 });
            volume.persist(entry);
            entry.load = 0;
            volume.persist(entry);
            await volume.flush();
            expect(await fs.readdir(root)).toEqual(["F"]);
        });

        it("makes directories, puts files in them, and removes them again", async () => {
            const volume = await make();
            const games = volume.makeDirectory(volume.root, "GAMES");
            const elite = volume.createFile(games, "ELITE", { data: Uint8Array.of(1) });
            volume.persist(elite);
            await volume.flush();
            expect(await fs.readdir(path.join(root, "GAMES"))).toEqual(["ELITE"]);
            volume.remove(elite);
            volume.remove(games);
            await volume.flush();
            expect(await fs.readdir(root)).toEqual([]);
        });

        it("writes a name with a slash in it as a dot", async () => {
            const volume = await make();
            volume.persist(volume.createFile(volume.root, "prog/bas", { data: Uint8Array.of(1) }));
            await volume.flush();
            expect(await fs.readdir(root)).toEqual(["prog.bas"]);
        });

        it.each([["/"], ["//"]])("will not write to %j, which is a dot or two as a host name", async (name) => {
            const store = new FsStore(root);
            await expect(
                store.writeFile([name], { data: new Uint8Array(), load: 0, exec: 0, locked: false }),
            ).rejects.toThrow();
            expect(await fs.readdir(outside)).toEqual(["volume"]);
        });

        it("will not write through a .inf file that is a symbolic link", async () => {
            const target = path.join(outside, "target");
            await fs.writeFile(target, "keep");
            await fs.symlink(target, path.join(root, "GAME.inf"));
            const store = new FsStore(root);
            await expect(
                store.writeFile(["GAME"], { data: Uint8Array.of(1), load: 0x1900, exec: 0, locked: false }),
            ).rejects.toThrow(/symbolic link/);
            expect(await fs.readFile(target, "utf8")).toBe("keep");
        });

        it("will not write through a symbolic link, to a file or to a directory", async () => {
            const target = path.join(outside, "target");
            await fs.writeFile(target, "keep");
            await fs.symlink(target, path.join(root, "LINK"));
            const store = new FsStore(root);
            await expect(
                store.writeFile(["LINK"], { data: Uint8Array.of(1), load: 0, exec: 0, locked: false }),
            ).rejects.toThrow(/symbolic link/);
            expect(await fs.readFile(target, "utf8")).toBe("keep");

            await fs.mkdir(path.join(outside, "elsewhere"));
            await fs.symlink(path.join(outside, "elsewhere"), path.join(root, "DIR"));
            await expect(
                store.writeFile(["DIR", "F"], { data: Uint8Array.of(1), load: 0, exec: 0, locked: false }),
            ).rejects.toThrow(/outside/);
            expect(await fs.readdir(path.join(outside, "elsewhere"))).toEqual([]);
        });
    });
});
