// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Machine, buildEmulationConfig } from "../../src/web/machine.js";
import { AtomMMC2 } from "../../src/mmc.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const settings = (overrides = {}) => ({
    tubeCpuMultiplier: 1,
    coProcessor: false,
    model: { name: "B-DFS1.2" },
    hasMusic5000: false,
    hasTeletextAdaptor: false,
    hasEconet: false,
    fittedRoms: [],
    ...overrides,
});

describe("buildEmulationConfig", () => {
    const build = (overrides = {}) =>
        buildEmulationConfig({
            settings: settings(),
            parsedQuery: {},
            keyLayout: "physical",
            cpuMultiplier: 1,
            extraRoms: [],
            bankRoms: [],
            userPort: { read: () => 0xff, write: () => {} },
            printer: {},
            ...overrides,
        });

    it("hands over the fittings' ROMs apart from the URL's, those for a named bank among them", () => {
        const bankRoms = [{ bank: 7, rom: "banked.rom" }];
        const built = build({
            settings: settings({ fittedRoms: ["fitted.rom"] }),
            extraRoms: ["user.rom"],
            bankRoms,
        });
        expect(built).toMatchObject({ fittedRoms: ["fitted.rom"], bankRoms, extraRoms: ["user.rom"] });
    });

    it("fits a tube only when a co-processor was asked for", () => {
        expect(build().tube).toBeNull();
        expect(build({ settings: settings({ coProcessor: true }) }).tube).toBeTruthy();
    });

    it("turns the FDC logging flags on by their presence alone", () => {
        expect(build().debugFlags).toEqual({ logFdcCommands: false, logFdcStateChanges: false });
        expect(build({ parsedQuery: { logFdcCommands: "" } }).debugFlags.logFdcCommands).toBe(true);
    });
});

describe("Machine", () => {
    let deps;
    let fakeProcessor;

    beforeEach(() => {
        domFromIndexHtml("fsmenuitem");
        fakeProcessor = {
            uservia: {},
            acia: { addEventListener: vi.fn(), setRs423Handler: vi.fn() },
            teletextAdaptor: undefined,
            touchScreen: { onTransmit: vi.fn(), tryReceive: vi.fn(() => -1) },
            atommc: { SetMMCData: vi.fn() },
            initialise: vi.fn().mockResolvedValue(),
        };
        deps = {
            model: { isAtom: false, cyclesPerSecond: 2000000, cmosOverride: undefined },
            settings: settings(),
            parsedQuery: {},
            keyLayout: "physical",
            cpuMultiplier: 1,
            extraRoms: [],
            stationId: 101,
            userPort: {},
            printer: { attach: vi.fn() },
            speechOutput: { onTransmit: vi.fn() },
            video: {},
            audioHandler: { soundChip: {}, ddNoise: {}, relayNoise: {}, initialise: vi.fn().mockResolvedValue() },
            dbgr: {},
            build: vi.fn(() => fakeProcessor),
        };
    });

    afterEach(teardownDom);

    const make = () => new Machine(deps);

    it("builds the processor with everything bolted on and attaches the printer", () => {
        const machine = make();
        expect(machine.processor).toBe(fakeProcessor);
        const [model, fittings] = deps.build.mock.calls[0];
        expect(model).toBe(deps.model);
        expect(fittings.cmos).toBe(machine.cmos);
        expect(fittings.config).toBe(machine.spec);
        expect(Object.isFrozen(fittings.config)).toBe(true);
        expect(fittings.music5000).toBeNull();
        expect(deps.printer.attach).toHaveBeenCalledWith(fakeProcessor.uservia);
    });

    it.each([
        ["up", 12, 0x08],
        ["down", 13, 0x04],
        ["left", 14, 0x02],
        ["right", 15, 0x01],
        ["fire", 0, 0x10],
    ])("on an Atom, the gamepad's %s pulls its line of the AtoMMC joystick port low", (_, button, bit) => {
        const CmdReg = 0xb400;
        const CmdReadPort = 0xa2;
        const gamepadButtons = new Array(16).fill(false);
        gamepadButtons[button] = true;
        deps.model = { ...deps.model, isAtom: true };
        deps.gamepad = { gamepadButtons };
        fakeProcessor.atommc = new AtomMMC2({});
        const mmc = make().processor.atommc;

        mmc.write(CmdReg, CmdReadPort);
        expect(mmc.read(CmdReg)).toBe(0xff ^ bit);
    });

    it("hides the filestore menu on a machine without Econet", () => {
        const machine = make();
        expect(machine.econet).toBeNull();
        expect(document.getElementById("fsmenuitem").style.display).toBe("none");
    });

    it("fits an Econet when asked, sharing it with the CMOS", () => {
        deps.settings = settings({ hasEconet: true });
        const machine = make();
        expect(machine.econet).toBeTruthy();
        expect(document.getElementById("fsmenuitem").style.display).toBe("");
    });

    describe("start", () => {
        const startDeps = () => {
            const slots = {
                drive: (index) => `drive ${index}`,
                deck: "the deck",
                load: vi.fn().mockResolvedValue("loaded"),
            };
            return { media: { slots }, autoBoot: { insertBasic: vi.fn().mockResolvedValue() } };
        };

        it("initialises the audio and the processor, then wires the RS-423 handler", async () => {
            const machine = make();
            await machine.start(startDeps());
            expect(deps.audioHandler.initialise).toHaveBeenCalled();
            expect(fakeProcessor.initialise).toHaveBeenCalled();
            expect(fakeProcessor.acia.setRs423Handler).toHaveBeenCalled();
        });

        it("speaks what the machine transmits and forwards it to the touchscreen", async () => {
            const machine = make();
            await machine.start(startDeps());
            const handler = fakeProcessor.acia.setRs423Handler.mock.calls[0][0];
            handler.onTransmit(65);
            expect(fakeProcessor.touchScreen.onTransmit).toHaveBeenCalledWith(65);
            expect(deps.speechOutput.onTransmit).toHaveBeenCalledWith(65);
        });

        it("loads both discs and the tape into their slots, naming in the URL what the URL named", async () => {
            const machine = make();
            const started = startDeps();
            await machine.start({
                ...started,
                discImage: "elite.ssd",
                discImageInUrl: false,
                secondDiscImage: "sth:B.zip",
                tape: "t.uef",
            });
            const { load } = started.media.slots;
            expect(load).toHaveBeenCalledWith(
                "drive 0",
                expect.objectContaining({ ref: "elite.ssd", kind: "disc", title: "elite.ssd" }),
                { inUrl: false, recent: false, entry: "default" },
            );
            expect(load).toHaveBeenCalledWith("drive 1", expect.objectContaining({ ref: "sth:B.zip", source: "sth" }), {
                recent: false,
                entry: "url",
            });
            expect(load).toHaveBeenCalledWith("the deck", expect.objectContaining({ ref: "t.uef", kind: "tape" }), {
                recent: false,
                entry: "url",
            });
        });

        it("counts nothing a page starts with as loaded recently, even what the URL names", async () => {
            const machine = make();
            const started = startDeps();
            await machine.start({ ...started, discImage: "chuckie.ssd", discImageInUrl: true });
            expect(started.media.slots.load).toHaveBeenCalledWith("drive 0", expect.anything(), {
                inUrl: true,
                recent: false,
                entry: "url",
            });
        });

        it("finishes booting whatever became of an image", async () => {
            const machine = make();
            const started = startDeps();
            started.media.slots.load.mockResolvedValue("failed");
            await expect(machine.start({ ...started, discImage: "gone.ssd", tape: "t.uef" })).resolves.toBeDefined();
        });

        it("only loads an MMC image on an Atom", async () => {
            const machine = make();
            await machine.start({ ...startDeps(), mmcImage: "sd.img" });
            expect(fakeProcessor.atommc.SetMMCData).not.toHaveBeenCalled();
        });

        it("inserts a BASIC program to run when asked", async () => {
            const machine = make();
            const started = startDeps();
            await machine.start({ ...started, embedBasic: "10 PRINT", basicNeedsRun: false });
            expect(started.autoBoot.insertBasic).toHaveBeenCalledWith(expect.anything(), true);
        });
    });
});
