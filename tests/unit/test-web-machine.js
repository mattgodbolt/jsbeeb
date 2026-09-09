// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Machine, buildEmulationConfig } from "../../src/web/machine.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const settings = (overrides = {}) => ({
    tubeCpuMultiplier: 1,
    coProcessor: false,
    model: { name: "B-DFS1.2" },
    hasMusic5000: false,
    hasTeletextAdaptor: false,
    hasEconet: false,
    extraRoms: [],
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
            userPort: { read: () => 0xff, write: () => {} },
            printer: {},
            ...overrides,
        });

    it("lets the fittings' ROMs claim banks before the URL's", () => {
        const built = build({ settings: settings({ extraRoms: ["fitted.rom"] }), extraRoms: ["user.rom"] });
        expect(built.extraRoms).toEqual(["fitted.rom", "user.rom"]);
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
                { inUrl: false },
            );
            expect(load).toHaveBeenCalledWith("drive 1", expect.objectContaining({ ref: "sth:B.zip", source: "sth" }));
            expect(load).toHaveBeenCalledWith("the deck", expect.objectContaining({ ref: "t.uef", kind: "tape" }));
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
