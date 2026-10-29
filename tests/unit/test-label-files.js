import { describe, expect, it, vi } from "vitest";

import { LabelFiles, parseLabels } from "../../src/label-files.js";
import { NoNames, SymbolNames } from "../../src/symbol-names.js";
import { parseSet } from "../../src/symbol-sets.js";

// BeebAsm 1.10's output for a program at &1900 with a scoped `.inner`.
const BeebAsmGlobals = "[{'done':6413L,'end':6423L,'loop':6402L,'message':6417L,'start':6400L}]\n";
const BeebAsmAll = "[{'.start':6400L,'.loop':6402L,'.done':6413L,'._0.inner':6414L,'.message':6417L,'.end':6423L}]\n";
const BeebAsmBoth =
    "[{'done':6413L,'end':6423L,'loop':6402L,'message':6417L,'start':6400L,'.start':6400L,'.loop':6402L," +
    "'.done':6413L,'._0.inner':6414L,'.message':6417L,'.end':6423L}]\n";

const label = (name, address, bank = null) => ({ name, address, bank });

describe("label files", () => {
    describe("parsing", () => {
        it.each([
            [
                "BeebAsm's -d",
                BeebAsmGlobals,
                [
                    label("done", 0x190d),
                    label("end", 0x1917),
                    label("loop", 0x1902),
                    label("message", 0x1911),
                    label("start", 0x1900),
                ],
            ],
            [
                "BeebAsm's -dd, its scopes kept in the name",
                BeebAsmAll,
                [
                    label("start", 0x1900),
                    label("loop", 0x1902),
                    label("done", 0x190d),
                    label("_0.inner", 0x190e),
                    label("message", 0x1911),
                    label("end", 0x1917),
                ],
            ],
            ["BeebAsm's -d with -dd", BeebAsmBoth, expect.arrayContaining([label("_0.inner", 0x190e)])],
            [
                "BeebAsm's -d with -dd as its source now writes them, without a comma between the lists",
                "[{'start':6400L'.start':6400L,'._0.inner':6414L}]",
                [label("start", 0x1900), label("start", 0x1900), label("_0.inner", 0x190e)],
            ],
            [
                "VICE's save_labels, skipping a disc drive's",
                "al C:1900 .start\nal C:190d .done\nal 8:0300 .drive_code\n",
                [label("start", 0x1900), label("done", 0x190d)],
            ],
            [
                "cc65's VICE labels",
                "al 001900 .start\r\nal 00FFEE .oswrch\r\n",
                [label("start", 0x1900), label("oswrch", 0xffee)],
            ],
            [
                "b-em's simplesym, with a ROM bank and comments",
                "# mine\nstart=$1900\n  oswrch = &FFEE\nloop=1902\nservice=F:8003\n\n",
                [label("start", 0x1900), label("oswrch", 0xffee), label("loop", 0x1902), label("service", 0x8003, 15)],
            ],
            ["ACME's, with a comment after", "start\t= $1900 ; ?\n", [label("start", 0x1900)]],
        ])("reads %s", (_, text, labels) => {
            expect(parseLabels(text)).toEqual(labels);
        });

        it.each([
            ["an empty BeebAsm dump", "[{}]", "it has no labels"],
            ["a BeebAsm dump with something else in it", "[{'start':6400L,oops}]", 'it has ",oops" where a label goes'],
            ["a line that is none of them", "start=$1900\nhello there", 'line 2, "hello there", isn\'t'],
            ["an address past the top of memory", "al C:10000 .past", "line 1 has the address 65536, past $ffff"],
            ["a BeebAsm name past the top of memory", "[{'big':65536L}]", "'big' has the address 65536"],
        ])("refuses %s", (_, text, problem) => {
            expect(() => parseLabels(text)).toThrow(problem);
        });
    });

    describe("naming", () => {
        const mos = parseSet({
            format: 1,
            title: "MOS",
            licence: "MIT",
            source: "a test",
            system: true,
            globals: { oswrch: "0xffee", zp: "0x70" },
        });
        const mosNames = new SymbolNames([{ set: mos, regions: [] }]);
        const files = () => new LabelFiles({ load: vi.fn() });
        const add = (labelFiles, title, text, bank = null) => labelFiles.add({ title, source: "", text, bank });
        const nameAt = (names, address) => names.address(address, 0)?.name;

        it("leaves the sets' names as they are with no files", () => {
            expect(files().names(mosNames, 15)).toBe(mosNames);
        });

        it("names an address, an operand and a name's address from a file ahead of the sets", () => {
            const labelFiles = files();
            const file = add(labelFiles, "game.txt", "my_print=&FFEE\nstart=$1900");
            const names = labelFiles.names(mosNames, 15);
            expect(names.address(0xffee, 0)).toEqual({ name: "my_print", set: file.set });
            expect(names.operand(0x1900, 0xffee)?.name).toBe("my_print");
            expect(nameAt(names, 0x70)).toBe("zp");
            expect(names.addressOf("start", 0)).toBe(0x1900);
            expect(names.addressOf("oswrch", 0)).toBe(0xffee);
            expect(names.sets).toEqual([file.set, mos]);
            expect(file.set.title).toBe("game.txt");
        });

        it("names sideways memory from a tied file only while its bank is paged in, ahead of an untied file", () => {
            const labelFiles = files();
            add(labelFiles, "any.txt", "anywhere=8000\nzp=70");
            add(labelFiles, "rom.txt", "service=8003\nentry=8000\nworkspace=70", 4);
            add(labelFiles, "bem.txt", "basic=F:8000");
            expect([0x8000, 0x8003, 0x70].map((address) => nameAt(labelFiles.names(NoNames, 4), address))).toEqual([
                "entry",
                "service",
                "zp",
            ]);
            expect([0x8000, 0x8003, 0x70].map((address) => nameAt(labelFiles.names(NoNames, 15), address))).toEqual([
                "basic",
                undefined,
                "zp",
            ]);
            expect(labelFiles.names(NoNames, 15).addressOf("workspace", 0)).toBe(0x70);
            expect(labelFiles.names(NoNames, 15).addressOf("service", 0)).toBeUndefined();
        });

        it("replaces a file of the same title, forgets one, ties one to a bank, and says so each time", () => {
            const labelFiles = files();
            const changed = vi.fn();
            labelFiles.addEventListener("change", changed);
            add(labelFiles, "game.txt", "old=$8000");
            const game = add(labelFiles, "game.txt", "new=$8000");
            const other = add(labelFiles, "other.txt", "other=$1900");
            expect(labelFiles.files).toEqual([game, other]);
            expect(nameAt(labelFiles.names(NoNames, 0), 0x8000)).toBe("new");
            labelFiles.tie(game, 1);
            expect(nameAt(labelFiles.names(NoNames, 0), 0x8000)).toBeUndefined();
            labelFiles.remove(other);
            expect(labelFiles.files).toEqual([game]);
            expect(changed).toHaveBeenCalledTimes(5);
        });

        it("says which file isn't labels, and keeps what it had", () => {
            const labelFiles = files();
            add(labelFiles, "game.txt", "start=$1900");
            expect(() => add(labelFiles, "game.txt", "not labels")).toThrow(
                "game.txt isn't a label file jsbeeb reads: line 1",
            );
            expect(nameAt(labelFiles.names(NoNames, 0), 0x1900)).toBe("start");
        });

        it("fetches a file by URL, titled by the end of its path, or says what it couldn't fetch", async () => {
            const load = vi.fn(async (url) => {
                if (url.includes("missing")) throw new Error("404");
                return new TextEncoder().encode(BeebAsmGlobals);
            });
            const labelFiles = new LabelFiles({ load });
            const file = await labelFiles.load("https://example.com/build/game%20labels.txt?v=2", 7);
            expect(file).toMatchObject({ title: "game labels.txt", bank: 7 });
            expect(file.set.source).toBe("https://example.com/build/game%20labels.txt?v=2");
            expect((await labelFiles.load("labels/demo.txt", null)).set).toMatchObject({
                title: "demo.txt",
                source: "",
            });
            await expect(labelFiles.load("https://example.com/missing.txt", null)).rejects.toThrow(
                "Couldn't fetch the labels in https://example.com/missing.txt: 404",
            );
        });
    });
});
