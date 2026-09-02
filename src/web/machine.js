import { AtomCpu6502, Cpu6502 } from "../6502.js";
import { Cmos, localStoragePersistence } from "../cmos.js";
import { Econet } from "../econet.js";
import { LoadSD } from "../mmc.js";
import { tubeModelFor } from "../models.js";
import * as utils from "../utils.js";
import { toast } from "./toast.js";
import { errorText, reportLoadFailure, showNotice } from "./reporting.js";

/**
 * The machine's fittings as the CPU wants them handed over. Pure, so the bank
 * and flag decisions are testable on their own.
 */
export function buildEmulationConfig({
    settings,
    parsedQuery,
    keyLayout,
    cpuMultiplier,
    extraRoms,
    userPort,
    printer,
}) {
    return {
        keyLayout,
        cpuMultiplier,
        tubeCpuMultiplier: settings.tubeCpuMultiplier,
        videoCyclesBatch: parsedQuery.videoCyclesBatch,
        tube: settings.coProcessor ? tubeModelFor(settings.model) : null,
        hasMusic5000: settings.hasMusic5000,
        hasTeletextAdaptor: settings.hasTeletextAdaptor,
        // ROM order determines sideways bank allocation, and the fittings' ROMs claim banks
        // before any the user asked for with ?rom=.
        extraRoms: [...settings.extraRoms, ...extraRoms],
        userPort,
        printerPort: printer,
        getGamepads: function () {
            // Gamepads are only available in secure contexts. If e.g. loading from http:// urls they aren't there.
            return navigator.getGamepads ? navigator.getGamepads() : [];
        },
        debugFlags: {
            logFdcCommands: parsedQuery.logFdcCommands !== undefined,
            logFdcStateChanges: parsedQuery.logFdcStateChanges !== undefined,
        },
    };
}

/** The emulated machine itself: the processor with everything bolted to it, and its start-up. */
export class Machine {
    constructor({
        model,
        settings,
        parsedQuery,
        keyLayout,
        cpuMultiplier,
        extraRoms,
        stationId,
        userPort,
        printer,
        speechOutput,
        video,
        audioHandler,
        dbgr,
        makeCpu = (CpuClass, ...args) => new CpuClass(...args),
    }) {
        this.model = model;
        this.audioHandler = audioHandler;
        this.speechOutput = speechOutput;

        this.econet = null;
        if (settings.hasEconet) {
            this.econet = new Econet(stationId, model.cyclesPerSecond);
        } else {
            document.getElementById("fsmenuitem").style.display = "none";
        }

        this.cmos = new Cmos(
            localStoragePersistence(
                () => window.localStorage,
                (error) =>
                    toast(
                        `Settings changed with *CONFIGURE will not be kept (${errorText(error)}). Check that this site is allowed to store data, and that its storage is not full.`,
                        { title: "Settings", quietKey: "quietCmosSave" },
                    ),
            ),
            model.cmosOverride,
            this.econet,
        );

        this.emulationConfig = buildEmulationConfig({
            settings,
            parsedQuery,
            keyLayout,
            cpuMultiplier,
            extraRoms,
            userPort,
            printer,
        });

        const CpuClass = model.isAtom ? AtomCpu6502 : Cpu6502;
        this.processor = makeCpu(CpuClass, model, {
            dbgr,
            video,
            soundChip: audioHandler.soundChip,
            ddNoise: audioHandler.ddNoise,
            relayNoise: audioHandler.relayNoise,
            music5000: settings.hasMusic5000 ? audioHandler.music5000 : null,
            cmos: this.cmos,
            config: this.emulationConfig,
            econet: this.econet,
        });

        printer.attach(this.processor.uservia);
        this.processor.teletextAdaptor?.addEventListener("notice", showNotice);
        this.processor.acia.addEventListener("notice", showNotice);
    }

    /**
     * Attach an RS-423 composite handler to the ACIA that combines the touchscreen
     * (which sends position data to the BBC) with the speech output (which speaks
     * text the BBC sends out).
     */
    setupRs423Handler() {
        const { processor, speechOutput } = this;
        processor.acia.setRs423Handler({
            onTransmit(val) {
                processor.touchScreen.onTransmit(val);
                speechOutput.onTransmit(val);
            },
            tryReceive(rts) {
                return processor.touchScreen.tryReceive(rts);
            },
        });
    }

    /**
     * Initialises the machine and starts every image the URL asked for, each
     * reporting its own failure without stopping the boot (#808).
     */
    async start({
        media,
        drives,
        autoBoot,
        discImage,
        secondDiscImage,
        tape,
        mmcImage,
        loadBasic,
        embedBasic,
        basicNeedsRun,
    }) {
        const { processor } = this;
        await Promise.all([this.audioHandler.initialise(), processor.initialise()]);

        // Wire up the composite RS-423 handler now that the touchscreen exists.
        this.setupRs423Handler();

        // Ideally would start the loads first. But their completion needs the FDC from the processor
        const imageLoads = [];

        function startImageLoad(description, load) {
            const loading = (async () => {
                try {
                    await load();
                } catch (error) {
                    reportLoadFailure(description, error);
                }
            })();
            imageLoads.push(loading);
            return loading;
        }

        if (discImage) {
            startImageLoad(`disc ${discImage}`, async () => {
                const loadedDisc = await media.loadDiscImage(discImage, drives.layoutForDrive(0));
                if (loadedDisc) drives.putDiscIn(0, loadedDisc);
            });
        }

        if (secondDiscImage) {
            startImageLoad(`disc ${secondDiscImage}`, async () => {
                const loadedDisc = await media.loadDiscImage(secondDiscImage, drives.layoutForDrive(1));
                if (loadedDisc) drives.putDiscIn(1, loadedDisc);
            });
        }

        if (tape) {
            startImageLoad(`tape ${tape}`, async () => media.setProcessorTape(await media.loadTapeImage(tape)));
        }

        if (mmcImage && this.model.isAtom) {
            startImageLoad(`MMC image ${mmcImage}`, async () => processor.atommc.SetMMCData(await LoadSD(mmcImage)));
        }

        if (loadBasic) {
            await startImageLoad(`BASIC program ${loadBasic}`, () =>
                autoBoot.insertBasic(
                    (async () => {
                        const data = await utils.loadData(loadBasic);
                        return String.fromCharCode.apply(null, data);
                    })(),
                    basicNeedsRun,
                ),
            );
        }

        if (embedBasic) {
            await startImageLoad("the BASIC program from the URL", () =>
                autoBoot.insertBasic(Promise.resolve(embedBasic), true),
            );
        }

        return Promise.all(imageLoads);
    }
}
