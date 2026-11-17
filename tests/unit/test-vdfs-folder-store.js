import { beforeEach, describe, expect, it } from "vitest";

import { FolderStore } from "../../src/web/vdfs-folder-store.js";
import { FakeDirectory } from "../helpers/fake-directory-handle.js";

const written = (data = [1], extra = {}) => ({
    data: Uint8Array.from(data),
    load: 0,
    exec: 0,
    locked: false,
    ...extra,
});

describe("VDFS folder store, over a folder the browser handed over", () => {
    let root;
    let store;

    beforeEach(() => {
        root = new FakeDirectory("volume");
        store = new FolderStore(async () => root);
    });

    describe("permission", () => {
        it.each([["granted"], ["prompt"], ["denied"]])("says it is %s, as the browser does", async (state) => {
            root.permission = state;
            expect(await store.permission()).toBe(state);
        });

        it("says there is no folder if none was chosen, and every call then says so", async () => {
            store = new FolderStore(async () => null);
            expect(await store.permission()).toBe("none");
            await expect(store.list([])).rejects.toThrow("No folder has been chosen");
        });

        it("will not touch a folder it has not been allowed to use", async () => {
            root.permission = "prompt";
            await expect(store.find([], "X")).rejects.toThrow("may be used");
            await expect(store.writeFile(["X"], written())).rejects.toThrow("may be used");
            expect(root.namesIn()).toEqual([]);
        });
    });

    describe("finding and listing", () => {
        it("says what is there, with the addresses and lock its .inf file gives, and matches in any case", async () => {
            root.put("MENU", "abc").put("MENU.inf", "$.MENU  FFFF1900 FFFF8023 00000003 L\n");
            expect(await store.find([], "menu")).toEqual({
                name: "MENU",
                isDirectory: false,
                size: 3,
                load: 0xffff1900,
                exec: 0xffff8023,
                locked: true,
            });
            expect(await store.find([], "NOPE")).toBeNull();
            expect(await store.find(["NOPE"], "X")).toBeNull();
        });

        it("lists files and directories, shows a dot in a host name as a slash, and does not show .inf files", async () => {
            root.put("GAMES/ELITE", "x").put("GAMES/ELITE.inf", "$.ELITE 1 2 1\n").put("a.b", "y").put("README", "z");
            const { entries, skipped } = await store.list([]);
            expect(entries.map((entry) => [entry.name, entry.isDirectory])).toEqual([
                ["a/b", false],
                ["GAMES", true],
                ["README", false],
            ]);
            expect(skipped).toEqual([]);
            expect((await store.list(["GAMES"])).entries.map((entry) => entry.name)).toEqual(["ELITE"]);
            expect(await store.list(["README"])).toBeNull();
        });

        it("names what the 6502 could not, so that it can be told", async () => {
            root.put("OK", "x").put("has space", "y").put("a-very-long-name-indeed", "z");
            const { entries, skipped } = await store.list([]);
            expect(entries.map((entry) => entry.name)).toEqual(["OK"]);
            expect(skipped.sort()).toEqual(["a-very-long-name-indeed", "has space"]);
        });
    });

    describe("reading and writing", () => {
        it("reads a file's bytes, and says when there is none", async () => {
            root.put("DATA", [1, 2, 3]);
            expect([...(await store.read(["DATA"]))]).toEqual([1, 2, 3]);
            await expect(store.read(["NOPE"])).rejects.toThrow("NOPE is not there");
        });

        it("writes a file with a .inf file beside it when it has addresses, and none when it has not", async () => {
            await store.writeFile(["PLAIN"], written([1, 2]));
            await store.writeFile(["PROG"], written([3], { load: 0x1900, exec: 0x8023, locked: true }));
            expect(root.namesIn()).toEqual(["PLAIN", "PROG", "PROG.inf"]);
            expect(root.textAt("PROG.inf")).toBe("$.PROG  00001900 00008023 00000001 L\n");
        });

        it("replaces a file, drops a .inf file that has become unneeded, and replaces one saved under another case", async () => {
            await store.writeFile(["PROG"], written([3], { load: 1 }));
            await store.writeFile(["PROG"], written([4, 5]));
            expect(root.namesIn()).toEqual(["PROG"]);
            await store.writeFile(["prog"], written([6]));
            expect(root.namesIn()).toEqual(["prog"]);
            expect([...(await store.read(["PROG"]))]).toEqual([6]);
        });

        it("writes a name with a slash in it as a dot", async () => {
            await store.writeFile(["A/B"], written());
            expect(root.namesIn()).toEqual(["A.B"]);
        });

        it("changes a file's addresses or lock, and leaves what it holds and the rest of what its .inf file said", async () => {
            await store.writeFile(["PROG"], written([7, 8], { load: 0x1900, exec: 0x8023 }));
            await store.setInfo(["PROG"], { locked: true });
            await store.setInfo(["PROG"], { exec: 0x2000 });
            expect(await store.find([], "PROG")).toMatchObject({ load: 0x1900, exec: 0x2000, locked: true, size: 2 });
            await expect(store.setInfo(["NOPE"], { locked: true })).rejects.toThrow("NOPE is not there");
        });

        it("makes directories, puts files in them, and removes them again", async () => {
            await store.makeDirectory(["GAMES", "OLD"]);
            await store.writeFile(["GAMES", "ELITE"], written());
            expect(root.namesIn("GAMES")).toEqual(["ELITE", "OLD"]);
            await expect(store.remove(["GAMES"])).rejects.toThrow();
            await store.remove(["GAMES", "OLD"]);
            await store.remove(["GAMES", "ELITE"]);
            await store.remove(["GAMES"]);
            expect(root.namesIn()).toEqual([]);
        });

        it("removes a file's .inf file with it", async () => {
            await store.writeFile(["PROG"], written([1], { load: 1 }));
            await store.remove(["PROG"]);
            expect(root.namesIn()).toEqual([]);
        });
    });

    describe("writing only what the BBC could have made", () => {
        it.each([[[]], [["has space"]], [["TOO-LONG-A-NAME"]], [["x/inf"]]])("refuses %j", async (volumePath) => {
            await expect(store.writeFile(volumePath, written())).rejects.toThrow("not a name VDFS can write");
            await expect(store.makeDirectory(volumePath)).rejects.toThrow("not a name VDFS can write");
            await expect(store.remove(volumePath)).rejects.toThrow("not a name VDFS can write");
            expect(root.namesIn()).toEqual([]);
        });

        it("says that a file is not there, and a directory to put it in", async () => {
            await expect(store.writeFile(["NO", "FILE"], written())).rejects.toThrow("NO is not there");
        });
    });
});
