import { describe, expect, it, vi } from "vitest";

import { Entry, VdfsVolume, isValidName, wildcardMatcher } from "../../src/vdfs-volume.js";
import { MemoryStore, directory, file } from "../helpers/vdfs.js";

const Where = (volume) => ({ cwd: volume.root, library: volume.root });

describe("VDFS volume", () => {
    describe("names", () => {
        it.each([
            ["ELITE", true],
            ["!BOOT", true],
            ["A/B", true],
            ["", false],
            ["ELEVENCHARS", false],
            ["A.B", false],
            ["A:B", false],
            ["A*B", false],
            ["A#B", false],
            ['A"B', false],
            ["CAFÉ", false],
            ["A B", false],
            ["$", false],
            ["&", false],
            ["%", false],
            ["@", false],
            ["^", false],
            ["FOO/INF", false],
            ["foo/Inf", false],
            ["INF", true],
            ["A/INFO", true],
            ["A\u0001B", false],
        ])("%j is a name: %s", (name, valid) => {
            expect(isValidName(name)).toBe(valid);
        });

        it("matches wildcards whatever the case, with * for any run and # for any one character", () => {
            const matches = (pattern, name) => wildcardMatcher(pattern).test(name);
            expect(matches("EL*", "Elite")).toBe(true);
            expect(matches("*", "")).toBe(true);
            expect(matches("E#ITE", "ELITE")).toBe(true);
            expect(matches("E#ITE", "EITE")).toBe(false);
            expect(matches("A+B", "A+B")).toBe(true);
            expect(matches("A+B", "AAB")).toBe(false);
        });
    });

    describe("the tree", () => {
        it("makes the directories a path passes through, and keeps each name as it was given", async () => {
            const volume = await VdfsVolume.open(new MemoryStore([file("Games.Elite", "x")]));
            const games = volume.root.children.get("GAMES");
            expect(games.isDirectory).toBe(true);
            expect(games.name).toBe("Games");
            expect(games.children.get("ELITE").path).toEqual(["Games", "Elite"]);
            expect(games.children.get("ELITE").parent).toBe(games);
        });

        it("lists a directory in name order, whatever the case", async () => {
            const volume = await VdfsVolume.open(new MemoryStore([file("b"), file("A"), file("c")]));
            expect(volume.root.listing().map((entry) => entry.name)).toEqual(["A", "b", "c"]);
        });

        it("treats a name with only a drive, or nothing, as the current directory", async () => {
            const volume = await VdfsVolume.open(new MemoryStore([directory("D")]));
            const cwd = volume.root.children.get("D");
            expect(volume.resolve("", { cwd, library: cwd }).entry).toBe(cwd);
            expect(volume.resolve(":0", { cwd, library: cwd }).entry).toBe(cwd);
            expect(volume.resolve(":0.$", { cwd, library: cwd }).entry).toBe(volume.root);
        });

        it("gives the directory and leaf of a name that is not there yet, for creating it", async () => {
            const volume = await VdfsVolume.open(new MemoryStore([directory("D")]));
            const { parent, name, entry } = volume.resolve("D.NEW", Where(volume));
            expect(parent).toBe(volume.root.children.get("D"));
            expect(name).toBe("NEW");
            expect(entry).toBeUndefined();
        });

        it("will not step through a file as though it were a directory", async () => {
            const volume = await VdfsVolume.open(new MemoryStore([file("F")]));
            expect(() => volume.resolve("F.X", Where(volume))).toThrow("Not a directory");
        });

        it("stops at the root when asked for its parent", async () => {
            const volume = await VdfsVolume.open(new MemoryStore());
            expect(volume.resolve("^", Where(volume)).entry).toBe(volume.root);
        });
    });

    describe("file contents", () => {
        it("grows a file by doubling, zero-filling what a seek past the end leaves, and shrinks it", () => {
            const entry = new Entry("F", { data: Uint8Array.of(1, 2, 3) });
            entry.resize(6);
            expect([...entry.bytes]).toEqual([1, 2, 3, 0, 0, 0]);
            expect(entry.buffer.length).toBeGreaterThanOrEqual(6);
            entry.resize(1);
            entry.resize(3);
            expect([...entry.bytes]).toEqual([1, 0, 0]);
        });
    });

    describe("persistence", () => {
        it("hands changes to the store in the order they were made, one at a time", async () => {
            const store = new MemoryStore();
            const order = [];
            store.writeFile = async (path) => {
                order.push(`start ${path}`);
                await new Promise((resolve) => setTimeout(resolve, path[0] === "SLOW" ? 20 : 0));
                order.push(`end ${path}`);
            };
            const volume = await VdfsVolume.open(store);
            volume.persist(volume.createFile(volume.root, "SLOW"));
            volume.persist(volume.createFile(volume.root, "FAST"));
            await volume.flush();
            expect(order).toEqual(["start SLOW", "end SLOW", "start FAST", "end FAST"]);
        });

        it("sends a copy of the bytes as they were when it was asked, not as they become", async () => {
            const store = new MemoryStore();
            const volume = await VdfsVolume.open(store);
            const entry = volume.createFile(volume.root, "F", { data: Uint8Array.of(1) });
            volume.persist(entry);
            entry.buffer[0] = 9;
            await volume.flush();
            expect([...store.files.get("F").data]).toEqual([1]);
        });

        it("notes a store's failure and carries on with the changes after it, without throwing", async () => {
            const error = vi.spyOn(console, "error").mockImplementation(() => {});
            const store = new MemoryStore();
            const failure = new Error("disc full");
            store.writeFile = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue();
            const volume = await VdfsVolume.open(store);
            volume.persist(volume.createFile(volume.root, "A"));
            volume.persist(volume.createFile(volume.root, "B"));
            await volume.flush();
            expect(store.writeFile).toHaveBeenCalledTimes(2);
            expect(volume.persistFailures).toEqual([{ operation: "writeFile", error: failure }]);
            error.mockRestore();
        });

        it("carries on when whoever is listening fails too", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const store = new MemoryStore();
            store.writeFile = vi.fn().mockRejectedValueOnce(new Error("disc full")).mockResolvedValue();
            const volume = await VdfsVolume.open(store);
            volume.onPersistFailure = () => {
                throw new Error("toast failed");
            };
            volume.persist(volume.createFile(volume.root, "A"));
            volume.persist(volume.createFile(volume.root, "B"));
            await expect(volume.flush()).resolves.toBeUndefined();
            expect(store.writeFile).toHaveBeenCalledTimes(2);
            vi.restoreAllMocks();
        });

        it("tells whoever is listening when the store fails, so the failure is not only in a log", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const store = new MemoryStore();
            store.writeFile = vi.fn().mockRejectedValue(new Error("disc full"));
            const volume = await VdfsVolume.open(store);
            volume.onPersistFailure = vi.fn();
            volume.persist(volume.createFile(volume.root, "A"));
            await volume.flush();
            expect(volume.onPersistFailure).toHaveBeenCalledWith(
                "writeFile",
                expect.objectContaining({ message: "disc full" }),
            );
            vi.restoreAllMocks();
        });

        it("does not persist a file that is no longer in the tree, as one that was deleted or replaced is not", async () => {
            const store = new MemoryStore();
            const volume = await VdfsVolume.open(store);
            const deleted = volume.createFile(volume.root, "GONE");
            volume.remove(deleted);
            const replaced = volume.createFile(volume.root, "SAME");
            volume.createFile(volume.root, "SAME");
            volume.persist(deleted);
            volume.persist(replaced);
            await volume.flush();
            expect(store.log).toEqual([["remove", "GONE"]]);
        });

        it("will not remove the root", async () => {
            const volume = await VdfsVolume.open(new MemoryStore());
            expect(() => volume.remove(volume.root)).toThrow("Access violation");
        });

        it("refuses to remove a directory with something in it, or a locked file", async () => {
            const volume = await VdfsVolume.open(new MemoryStore([file("D.F"), file("LOCKED", "", { locked: true })]));
            expect(() => volume.remove(volume.root.children.get("D"))).toThrow("Dir not empty");
            expect(() => volume.remove(volume.root.children.get("LOCKED"))).toThrow("Locked");
        });

        it("needs no store, as a volume that is only for the session", async () => {
            const volume = new VdfsVolume();
            volume.persist(volume.createFile(volume.root, "F"));
            volume.makeDirectory(volume.root, "D");
            await expect(volume.flush()).resolves.toBeUndefined();
        });
    });
});
