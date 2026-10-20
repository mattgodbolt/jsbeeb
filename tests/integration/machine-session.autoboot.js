import { describe, it, expect } from "vitest";
import { AutobootMaxFrames, MachineSession } from "../../src/machine-session.js";
import { BBC } from "../../src/keymap.js";
import { BootTimeout, bootedSession } from "../helpers/machine-session.js";

describe("MachineSession autoboot", () => {
    const WelcomeBootMessage = "This message was automatically loaded.";
    const FramesToRunWelcomeBoot = 200;
    const DfsBank = 14;
    // In DFS 1.2, reached only once service call 3 has asked it to boot, and before it starts the drive.
    const DfsBootPathAddress = 0xb475;
    const ResetVector = 0xfffc;
    const Oswrch = 0xffee;

    async function unbootedSession(modelName) {
        const session = new MachineSession(modelName);
        await session.initialise();
        return session;
    }

    const driveZero = (session) => session._machine.processor.fdc.drives[0];

    function expectHeldForAWhile({ framesHeld }) {
        expect(framesHeld).toBeGreaterThan(0);
        expect(framesHeld).toBeLessThan(AutobootMaxFrames);
    }

    async function expectWelcomeBooted(session) {
        await session.runFrames(FramesToRunWelcomeBoot);
        expect(session.drainOutput().screenText).toContain(WelcomeBootMessage);
    }

    for (const modelName of ["B-DFS1.2", "B1770", "Master"]) {
        it(
            `boots the Welcome disc on a ${modelName} and lets go of SHIFT`,
            async () => {
                const session = await bootedSession(modelName);
                const booted = await session.bootDisc("Welcome.ssd");
                expect(booted).toMatchObject({
                    name: "Welcome.ssd",
                    ignored: [],
                    bootRequested: true,
                    completed: true,
                });
                expectHeldForAWhile(booted);
                expect(driveZero(session).spinning).toBe(true);
                expect(session.heldKeys()).toEqual([]);
                await expectWelcomeBooted(session);
                session.destroy();
            },
            BootTimeout,
        );

        it(
            `leaves drive 0 alone on a ${modelName}'s plain reset with a disc in`,
            async () => {
                const session = await bootedSession(modelName);
                await session.loadDiscImage("Welcome.ssd");
                let starts = 0;
                driveZero(session).addEventListener("startSpinning", () => starts++);
                session.reset(true);
                await session.runFrames(FramesToRunWelcomeBoot);
                expect(starts).toBe(0);
                session.destroy();
            },
            BootTimeout,
        );
    }

    for (const modelName of ["B-DFS1.2", "Master"]) {
        it(
            `boots a disc already in a ${modelName}'s drive with a soft reset`,
            async () => {
                const session = await bootedSession(modelName);
                await session.loadDiscImage("Welcome.ssd");
                const booted = await session.autoboot({ hard: false });
                expect(booted.completed).toBe(true);
                expectHeldForAWhile(booted);
                await expectWelcomeBooted(session);
                session.destroy();
            },
            BootTimeout,
        );
    }

    it(
        "boots a MasterADFS into ADFS, and spins its drive for SHIFT+BREAK though ADFS cannot boot a DFS disc",
        async () => {
            const session = new MachineSession("MasterADFS");
            await session.initialise();
            expect((await session.boot(30)).screenText).toContain("Acorn ADFS");
            expect(await session.bootDisc("Welcome.ssd")).toMatchObject({ completed: true });
            await session.runFrames(FramesToRunWelcomeBoot);
            expect(session.drainOutput().screenText).not.toContain(WelcomeBootMessage);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "has a MasterADFS start drive 0 on a plain BREAK after *CAT, so the motor alone does not show a boot",
        async () => {
            const session = await bootedSession("MasterADFS");
            await session.loadDiscImage("Welcome.ssd");
            await session.type("*CAT");
            await session.runFrames();
            let starts = 0;
            driveZero(session).addEventListener("startSpinning", () => starts++);
            session.reset(false);
            await session.runFrames(FramesToRunWelcomeBoot);
            expect(starts).toBeGreaterThan(0);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "throws on a B1770A, whose boot goes to ADFS without starting drive 0",
        async () => {
            const session = await bootedSession("B1770A");
            await expect(session.bootDisc("Welcome.ssd")).rejects.toThrow(/drive 0 did not start/);
            session.destroy();
        },
        BootTimeout,
    );

    it(
        "throws on a Master configured to boot, where SHIFT means do not",
        async () => {
            const session = await bootedSession("Master");
            await session.type("*CONFIGURE BOOT");
            await session.runUntilPrompt(5);
            let starts = 0;
            driveZero(session).addEventListener("startSpinning", () => starts++);
            await expect(session.bootDisc("Welcome.ssd")).rejects.toThrow(
                /did not ask the filing system to boot.*CONFIGURE BOOT/,
            );
            expect(session.heldKeys()).toEqual([]);
            expect(starts).toBe(0);
            session.destroy();
        },
        BootTimeout,
    );

    it("refuses while a key is held, before touching the drive", async () => {
        const session = await unbootedSession("B-DFS1.2");
        session.keyDownRaw(BBC.CTRL);
        await expect(session.bootDisc("Welcome.ssd")).rejects.toThrow("release the keys held first");
        expect(driveZero(session).disc).toBeUndefined();
        session.destroy();
    });

    it(
        "refuses while typing is pending, before touching the drive",
        async () => {
            const session = await bootedSession("B-DFS1.2");
            const id = session.addBreakpoint("execute", Oswrch);
            await session.type("X");
            session.removeBreakpoint(id);
            await expect(session.bootDisc("Welcome.ssd")).rejects.toThrow(/cancelTyping/);
            expect(driveZero(session).disc).toBeUndefined();
            session.destroy();
        },
        BootTimeout,
    );

    it("refuses an empty drive", async () => {
        const session = await unbootedSession("B-DFS1.2");
        await expect(session.autoboot()).rejects.toThrow("there is no disc in drive 0");
        session.destroy();
    });

    it(
        "boots a MasterANFS into ANFS, and throws when SHIFT+BREAK's boot goes there and the drive never starts",
        async () => {
            const session = new MachineSession("MasterANFS", { econet: true });
            await session.initialise();
            expect((await session.boot(30)).screenText).toContain("Econet Station");
            await expect(session.bootDisc("Welcome.ssd")).rejects.toThrow(/drive 0 did not start/);
            expect(session.heldKeys()).toEqual([]);
            session.destroy();
        },
        BootTimeout,
    );

    for (const [where, breakAt] of [
        ["the reset", (session) => session.readMemory(ResetVector, 2).reduce((low, high) => low | (high << 8))],
        ["the banner", () => Oswrch],
    ]) {
        for (const modelName of ["B-DFS1.2", "Master"]) {
            it(
                `stops a ${modelName} at a breakpoint in ${where}, before the boot is asked for, and running on does not boot`,
                async () => {
                    const session = await bootedSession(modelName);
                    session.addBreakpoint("execute", breakAt(session));
                    expect(await session.bootDisc("Welcome.ssd")).toMatchObject({
                        bootRequested: false,
                        completed: false,
                    });
                    expect(session.hitBreakpoint()).not.toBeNull();
                    expect(session.heldKeys()).toEqual([]);
                    session.clearBreakpoints();
                    await session.runFrames(FramesToRunWelcomeBoot);
                    expect(session.drainOutput().screenText).not.toContain(WelcomeBootMessage);
                    session.destroy();
                },
                BootTimeout,
            );
        }
    }

    it(
        "stops at a breakpoint after the boot is asked for, and running on boots",
        async () => {
            const session = await bootedSession("B-DFS1.2");
            session.addBreakpoint("execute", DfsBootPathAddress, { bank: DfsBank });
            expect(await session.bootDisc("Welcome.ssd")).toMatchObject({ bootRequested: true, completed: false });
            expect(session.hitBreakpoint()).not.toBeNull();
            session.clearBreakpoints();
            await expectWelcomeBooted(session);
            session.destroy();
        },
        BootTimeout,
    );

    it("refuses on the Atom, before touching the drive", async () => {
        const session = await unbootedSession("Atom");
        await expect(session.bootDisc("Welcome.ssd")).rejects.toThrow("the Atom has no SHIFT+BREAK disc boot");
        expect(driveZero(session).disc).toBeUndefined();
        session.destroy();
    });
});
