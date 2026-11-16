import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MachineSession } from "../../src/machine-session.js";
import { BootTimeout } from "../helpers/machine-session.js";

const CommandCycles = 2_000_000;

describe("VDFS in a running machine", () => {
    let folder;
    let session;

    beforeEach(async () => {
        folder = await mkdtemp(path.join(os.tmpdir(), "vdfs-machine-"));
    });

    afterEach(async () => {
        session?.destroy();
        session = undefined;
        await rm(folder, { recursive: true, force: true });
    });

    /** A booted machine of `model`, with `folder` served, whatever the options add. */
    async function boot(model = "B-DFS1.2", options = {}) {
        session = new MachineSession(model, { vdfsFolder: folder, ...options });
        await session.initialise();
        await session.boot(30);
        return session;
    }

    /** Types a line and gives what the machine showed while it ran, without the line itself. */
    async function enter(line, cycles = CommandCycles) {
        await session.type(line);
        await session.runFor(cycles);
        return session.drainOutput().screenText.replace(line, "").replace(/>\s*$/, "").trim();
    }

    describe.each([["B-DFS1.2"], ["Master"]])("on a %s", (model) => {
        it(
            "saves and loads files, and keeps the BASIC program that was saved",
            async () => {
                await boot(model);
                await enter("*VDFS");
                await enter('10 PRINT "FROM VDFS"');
                await enter('SAVE "PROG"');
                await enter("NEW");
                expect(await enter('CHAIN "PROG"')).toBe("FROM VDFS");
                await session.flushVdfs();
                expect((await readFile(path.join(folder, "PROG"))).length).toBeGreaterThan(10);
            },
            BootTimeout,
        );

        it(
            "serves a file that was in the folder, with the addresses its .inf gives",
            async () => {
                await writeFile(path.join(folder, "HELLO"), Uint8Array.of(0x48, 0x49));
                await writeFile(path.join(folder, "HELLO.inf"), "$.HELLO 00003000 00003000\n");
                await boot(model);
                await enter("*VDFS");
                expect(await enter("*INFO")).toContain("HELLO        00003000 00003000 000002");
                await enter("*LOAD HELLO");
                expect(await enter("PRINT ?&3000")).toBe("72");
            },
            BootTimeout,
        );
    });

    it(
        "lists a folder, goes into a directory of it, and says Bad command for what is not one",
        async () => {
            await mkdir(path.join(folder, "GAMES"));
            await writeFile(path.join(folder, "GAMES", "ELITE"), "x");
            await boot();
            await enter("*VDFS");
            expect(await enter("*CAT")).toMatch(/Dir\. \$\s+Lib\. \$\s+GAMES\s+D/);
            await enter("*DIR GAMES");
            expect(await enter("*CAT")).toMatch(/Dir\. \$\.GAMES[\s\S]*ELITE/);
            expect(await enter("*NOSUCHTHING")).toBe("Bad command");
        },
        BootTimeout,
    );

    it(
        "writes a file a byte at a time and reads it back, with the pointer and extent as BASIC sees them",
        async () => {
            await boot();
            await enter("*VDFS");
            await enter('F=OPENOUT("DATA")');
            await enter("FOR I%=1 TO 5:PRINT#F,I%*I%:NEXT:CLOSE#F");
            await enter('F=OPENIN("DATA")');
            expect(await enter("PRINT EXT#F")).toBe("25");
            await enter("X%=0:FOR I%=1 TO 5:INPUT#F,V%:X%=X%+V%:NEXT");
            expect(await enter("PRINT X%,EOF#F,PTR#F")).toMatch(/55\s+-1\s+25/);
            await enter("CLOSE#0");
            await session.flushVdfs();
            expect((await readdir(folder)).sort()).toEqual(["DATA"]);
        },
        BootTimeout,
    );

    it(
        "runs a machine code program from the folder, with *RUN and with its name alone",
        async () => {
            // LDA #&2A : STA &3000 : RTS
            await writeFile(path.join(folder, "PROG"), Uint8Array.of(0xa9, 0x2a, 0x8d, 0x00, 0x30, 0x60));
            await writeFile(path.join(folder, "PROG.inf"), "$.PROG 00001900 00001900\n");
            await boot();
            await enter("*VDFS");
            await enter("*RUN PROG");
            expect(await enter("PRINT ?&3000")).toBe("42");
            await enter("?&3000=0");
            await enter("*PROG");
            expect(await enter("PRINT ?&3000")).toBe("42");
        },
        BootTimeout,
    );

    it(
        "*EXECs a !BOOT file, which is how a folder starts itself",
        async () => {
            await writeFile(path.join(folder, "!BOOT"), 'PRINT "BOOTED"\r');
            await boot();
            await enter("*VDFS");
            expect(await enter("*EXEC !BOOT")).toMatch(/BOOTED$/);
        },
        BootTimeout,
    );

    it(
        "keeps out of the way when its ROM is fitted to a machine with no host",
        async () => {
            session = new MachineSession("B-DFS1.2", { extraRoms: ["vdfs.rom"] });
            await session.initialise();
            await session.boot(30);
            await session.type("*HELP");
            await session.runFor(CommandCycles);
            const help = session.drainOutput().screenText;
            expect(help).toContain("DFS 1.20");
            expect(help).not.toContain("VDFS");
        },
        BootTimeout,
    );

    it(
        "leaves the disc filing system working after it has been chosen, and chosen over again",
        async () => {
            await boot();
            await enter("*VDFS");
            await enter("*VDFS");
            expect(await enter("*DISC")).not.toContain("Bad command");
            expect(await enter("*CAT")).not.toContain("VDFS");
        },
        BootTimeout,
    );
});
