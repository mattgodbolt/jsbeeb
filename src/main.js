import { version } from "../package.json";

import "bootswatch/dist/darkly/bootstrap.min.css";
import "./jsbeeb.css";

import * as utils from "./utils.js";
import { Debugger } from "./web/debug.js";
import { Cpu6502, AtomCpu6502 } from "./6502.js";
import * as utils_atom from "./utils_atom.js";
import { LoadSD } from "./mmc.js";
import { Cmos, localStoragePersistence } from "./cmos.js";
import { GamePad } from "./gamepads.js";
import { Config } from "./config.js";
import { DefaultModel, findModel, tubeModelFor } from "./models.js";
import { initialise as electron } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { DefaultAudioOutput, isAudioOutput } from "./audio-output.js";
import { QuickSettings } from "./web/quick-settings.js";
import { Econet } from "./econet.js";
import { toast } from "./web/toast.js";
import { BuiltInImages, MediaLoader } from "./web/media-loader.js";
import { AutobootTicks } from "./web/archive-list.js";
import { SthPicker } from "./web/sth-picker.js";
import { HfePicker } from "./web/hfe-picker.js";
import { GoogleDrivePicker } from "./web/google-drive-picker.js";
import { isSnapshotFile, SnapshotUI } from "./web/snapshot-ui.js";
import { Autoboot } from "./web/autoboot.js";
import { Display } from "./web/display.js";
import { Layout } from "./web/layout.js";
import { EmulationLoop, RewindCaptureInterval } from "./web/emulation-loop.js";
import { KeyboardSetup } from "./web/keyboard-setup.js";
import { AnalogueInputs } from "./web/analogue-inputs.js";
import { FrontPanel } from "./web/front-panel.js";
import { Drives } from "./web/drives.js";
import { UrlState } from "./web/url-state.js";
import { Modals } from "./web/modals.js";
import { errorText, reportLoadFailure, showNotice } from "./web/reporting.js";
import { SpeechOutput } from "./speech-output.js";
import { Printer } from "./printer.js";
import { RewindBuffer } from "./rewind.js";
import { RewindUI } from "./rewind-ui.js";
import { DiscVisualiser } from "./disc-visualiser.js";
import { downloadDriveData } from "./dom-utils.js";
import {
    guessModelFromHostname,
    parseMediaParams,
    processAutobootParams,
    processDriveTrackParams,
    processInputParams,
} from "./url-params.js";

let processor;
let video;
let rewindUI;
const dbgr = new Debugger();
let model;

const gamepad = new GamePad();
if (!window.isSecureContext)
    toast("Gamepads only work over https, so any joystick plugged in here is not seen.", {
        title: "Gamepads",
        quietKey: "quietInsecureGamepads",
    });
let discImage = BuiltInImages[0].file;
const extraRoms = [];

let secondDiscImage = null;

const urlState = new UrlState(window.location, window.history);
const parsedQuery = urlState.params;
let { needsAutoboot, autoType } = processAutobootParams(parsedQuery);
let keyLayout = window.localStorage.keyLayout || "physical";

const BBC = utils.BBC;
const keyCodes = utils.keyCodes;
const cpuMultiplier = parsedQuery.cpuMultiplier ?? 1;
let noSeek;
let stationId = 101;
let econet = null;

// Parse disc and tape images from query parameters
const { discImage: queryDiscImage, secondDiscImage: querySecondDisc, mmcImage } = parseMediaParams(parsedQuery);
const { settings: driveTracks, warnings: driveTrackWarnings } = processDriveTrackParams(parsedQuery);

// Only assign if values are provided
if (queryDiscImage) discImage = queryDiscImage;
if (querySecondDisc) secondDiscImage = querySecondDisc;

// Handle specific query parameters
if (Array.isArray(parsedQuery.rom)) {
    parsedQuery.rom.forEach((romPath) => {
        if (romPath) extraRoms.push(romPath);
    });
}
if (parsedQuery.keyLayout) {
    keyLayout = (parsedQuery.keyLayout + "").toLowerCase();
}
if (parsedQuery.embed) {
    for (const el of document.querySelectorAll(".embed-hide")) el.style.display = "none";
    document.body.style.backgroundColor = "transparent";
}

noSeek = !!parsedQuery.noseek;

if (parsedQuery.stationId !== undefined) stationId = parsedQuery.stationId;

const printer = new Printer({
    onOutput: (char) => frontPanel.printChar(char),
    onFirstOutput: () =>
        toast("Printer output is being kept. Press Ctrl-B to open the printer window.", {
            title: "Printer",
            quietKey: "quietPrinterOutput",
        }),
});

const keys = new KeyboardSetup({
    enterDebugger: () => loop.stop(true),
    reload: () => window.location.reload(),
    toggleFast: () => loop.toggleFastAsPossible(),
    openRewind: () => {
        if (rewindUI) rewindUI.open();
    },
    openPrinter: () => frontPanel.checkPrinterWindow(),
    pause: () => loop.stop(false),
    resume: () => loop.go(),
    onAnyKeyDown: () => {
        audioHandler.tryResume();
        inputs.ensureMicrophoneRunning();
    },
});

// Speech output: initialised from URL param; can be toggled at runtime via the Settings panel.
// Must be created before Config so the onClose callback and the initial checkbox state can reference it.
const speechOutput = new SpeechOutput();

function setSpeechOutput(enabled) {
    speechOutput.enabled = enabled;
    if (enabled && typeof speechSynthesis === "undefined")
        toast("This browser has no speech synthesis, so speech output has nothing to speak with.", {
            title: "Speech",
        });
}
setSpeechOutput(!!parsedQuery.speechOutput);

const config = new Config(
    function onChange(changed) {
        if (changed.audioOutput) applyAudioOutput(changed.audioOutput);
        if (changed.speakerAmount !== undefined) applySpeakerAmount(changed.speakerAmount);
        if (changed.displayMode) applyDisplayMode(changed.displayMode);
    },
    function onClose(changed) {
        Object.assign(parsedQuery, changed);
        if (changed.keyLayout) {
            window.localStorage.keyLayout = changed.keyLayout;
            emulationConfig.keyLayout = changed.keyLayout;
            keys.setKeyLayout(changed.keyLayout);
        }
        if (changed.mouseJoystickEnabled !== undefined || changed.microphoneChannel !== undefined) {
            inputs.updateAdcSources(parsedQuery.mouseJoystickEnabled, parsedQuery.microphoneChannel);

            if (changed.microphoneChannel !== undefined) {
                inputs.setupMicrophone();
            }
        }
        if (changed.speechOutput !== undefined) setSpeechOutput(!!changed.speechOutput);
        if (changed.tubeCpuMultiplier !== undefined) {
            emulationConfig.tubeCpuMultiplier = changed.tubeCpuMultiplier;
            config.setTubeCpuMultiplier(changed.tubeCpuMultiplier);
            if (processor.hasTube) {
                processor.tube.cpuMultiplier = changed.tubeCpuMultiplier;
            }
        }
        urlState.updateUrl();
    },
    function onRestartRequired() {
        modals.areYouSure(
            "Your change is saved, but only takes effect when the emulator restarts. Restart now?",
            "Restart now",
            "Later",
            function () {
                window.location.reload();
            },
        );
    },
);

// Perform mapping of legacy models to the new format
config.mapLegacyModels(parsedQuery);

const requestedModelName = parsedQuery.model || guessModelFromHostname(window.location.hostname);
const requestedModel = findModel(requestedModelName);
if (!requestedModel)
    toast(`There is no model called "${requestedModelName}". Using ${DefaultModel.name} instead.`, {
        title: "Model",
    });
config.setModel((requestedModel ?? DefaultModel).name);
config.setKeyLayout(keyLayout);
config.setTubeCpuMultiplier(parsedQuery.tubeCpuMultiplier || 1);
config.setMicrophoneChannel(parsedQuery.microphoneChannel);
config.setCheckboxes({
    coProcessor: !!parsedQuery.coProcessor,
    hasEconet: !!parsedQuery.hasEconet,
    hasMusic5000: !!parsedQuery.hasMusic5000,
    hasTeletextAdaptor: !!parsedQuery.hasTeletextAdaptor,
    mouseJoystickEnabled: !!parsedQuery.mouseJoystickEnabled,
    speechOutput: speechOutput.enabled,
});
const displayMode = parsedQuery.displayMode || window.localStorage.displayMode || "rgb";
config.setDisplayMode(displayMode);
const audioOutput =
    [parsedQuery.audioOutput, window.localStorage.audioOutput].find(isAudioOutput) ?? DefaultAudioOutput;
const speakerAmount =
    [parsedQuery.speakerAmount, parseFloat(window.localStorage.speakerAmount)].find(Number.isFinite) ?? 1;

config.setAudioOutput(audioOutput);
config.setSpeakerAmount(speakerAmount);

// A slider fires for every pixel of a drag, and each URL update is a history entry.
const UrlSettleMs = 300;
const updateUrlOnceSettled = utils.debounce(() => urlState.updateUrl(), UrlSettleMs);

function applyAudioOutput(output) {
    audioHandler.setAudioOutput(output);
    config.setAudioOutput(output);
    quickSettings?.showAudioOutput(output);
    window.localStorage.audioOutput = output;
    parsedQuery.audioOutput = output;
    urlState.updateUrl();
}

function applySpeakerAmount(amount) {
    audioHandler.setSpeakerAmount(amount);
    config.setSpeakerAmount(amount);
    quickSettings?.showSpeakerAmount(amount);
    window.localStorage.speakerAmount = amount;
    parsedQuery.speakerAmount = amount;
    updateUrlOnceSettled();
}

function applyDisplayMode(mode) {
    display.setMode(mode);
    config.setDisplayMode(mode);
    quickSettings?.showDisplayMode(mode);
    window.localStorage.displayMode = mode;
    parsedQuery.displayMode = mode;
    urlState.updateUrl();
}

model = config.model;

// Must come after we know the model, to validate names against those of the hardware.
const keyMappingWarnings = processInputParams(
    parsedQuery,
    model.isAtom ? utils_atom.ATOM : BBC,
    keyCodes,
    utils.userKeymap,
    gamepad,
);

// Depends on the config.setX calls above having applied the URL parameters.
const emulationConfig = {
    keyLayout,
    cpuMultiplier,
    tubeCpuMultiplier: config.tubeCpuMultiplier,
    videoCyclesBatch: parsedQuery.videoCyclesBatch,
    tube: config.coProcessor ? tubeModelFor(config.model) : null,
    hasMusic5000: config.hasMusic5000,
    hasTeletextAdaptor: config.hasTeletextAdaptor,
    // ROM order determines sideways bank allocation, and the fittings' ROMs claim banks
    // before any the user asked for with ?rom=.
    extraRoms: [...config.extraRoms, ...extraRoms],
    userPort: keys.userPort,
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

if (cpuMultiplier !== 1) console.log(`CPU multiplier set to ${cpuMultiplier}`);
const cpuSpeed = model.cyclesPerSecond;
const clocksPerSecond = (cpuMultiplier * cpuSpeed) | 0;

let tryGl = true;
if (parsedQuery.glEnabled !== undefined) {
    tryGl = parsedQuery.glEnabled === "true";
}
let lowLatency = true;
if (parsedQuery.lowLatency !== undefined) {
    lowLatency = parsedQuery.lowLatency === "true";
}
const screenCanvas = document.getElementById("screen");

const modals = new Modals({
    isRunning: () => loop.isRunning(),
    stop: (debug) => loop.stop(debug),
    go: () => loop.go(),
});

if (keyMappingWarnings.length) {
    toast(`${keyMappingWarnings.join(" ")} The key names are listed in the README.`, {
        title: "Mappings in the URL",
    });
}

if (driveTrackWarnings.length) {
    toast(`${driveTrackWarnings.join(" ")} Auto is in use instead; pick 40 or 80 from the Discs menu.`, {
        title: "Disc drives",
    });
}

const display = new Display({
    screenCanvas,
    model,
    mode: displayMode,
    tryGl,
    lowLatency,
    fakeVideo: parsedQuery.fakeVideo !== undefined,
    frameSkip: parsedQuery.frameSkip ?? 0,
});
video = display.video;

const audioStatsEl = document.getElementById("audio-stats");
if (audioStatsEl) audioStatsEl.hidden = !parsedQuery.audioDebug;
const audioStatsNode = parsedQuery.audioDebug ? audioStatsEl : null;
const audioHandler = new AudioHandler({
    warningNode: document.getElementById("audio-warning"),
    statsNode: audioStatsNode,
    audioOutput,
    audioFilterFreq: parsedQuery.audiofilterfreq,
    audioFilterQ: parsedQuery.audiofilterq,
    speakerAmount,
    audioLatencyMs: parsedQuery.audioLatencyMs,
    noSeek,
    cpuSpeed,
    isAtom: model.isAtom,
    hasMusic5000: config.hasMusic5000,
});
// Firefox will report that audio is suspended even when it will
// start playing without user interaction, so we need to delay a
// little to get a reliable indication.
window.setTimeout(() => audioHandler.checkStatus(), 1000);
const quickSettings = new QuickSettings(
    { onAudioOutput: applyAudioOutput, onSpeakerAmount: applySpeakerAmount, onDisplayMode: applyDisplayMode },
    { audioOutput, speakerAmount, displayMode },
);

for (const el of document.querySelectorAll(".initially-hidden")) el.classList.remove("initially-hidden");

const pastetext = document.getElementById("paste-text");
pastetext.closest("form").addEventListener("submit", (event) => event.preventDefault());
pastetext.addEventListener("paste", function (event) {
    const text = event.clipboardData.getData("text/plain");
    keys.sendRawKeyboard(autoBoot.stringToMachineKeys(text), true);
});
window.addEventListener("blur", function () {
    keys.clearKeys();
    loop.setEmulationLead(audioHandler.setWindowFocused(false));
});
window.addEventListener("focus", () => loop.setEmulationLead(audioHandler.setWindowFocused(true)));

const debugPause = document.getElementById("debug-pause");
const debugPlay = document.getElementById("debug-play");

function pauseIntoDebugger() {
    loop.stop(true);
}

function resumeFromDebugger() {
    dbgr.hide();
    keys.resumeEmulation();
}

debugPause.addEventListener("click", pauseIntoDebugger);
debugPlay.addEventListener("click", resumeFromDebugger);

// To lower chance of data loss, only accept drop events in the drop
// zone in the menu bar.
document.addEventListener("dragover", function (event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
});
document.addEventListener("drop", function (event) {
    event.preventDefault();
});

window.addEventListener("beforeunload", function (event) {
    if (loop.isRunning() && processor.sysvia.hasAnyKeyDown()) {
        const message =
            "It seems like you're still using the emulator. If you're in Chrome, it's impossible for jsbeeb to prevent some shortcuts (like ctrl-W) from performing their default behaviour (e.g. closing the window).\n" +
            "As a workarond, create an 'Application Shortcut' from the Tools menu.  When jsbeeb runs as an application, it *can* prevent ctrl-W from closing the window.";
        event.preventDefault();
        event.returnValue = message;
        return message;
    }
});

if (config.hasEconet) {
    econet = new Econet(stationId, model.cyclesPerSecond);
} else {
    document.getElementById("fsmenuitem").style.display = "none";
}

const cmos = new Cmos(
    localStoragePersistence(
        () => window.localStorage,
        (error) =>
            toast(
                `Settings changed with *CONFIGURE will not be kept (${errorText(error)}). Check that this site is allowed to store data, and that its storage is not full.`,
                { title: "Settings", quietKey: "quietCmosSave" },
            ),
    ),
    model.cmosOverride,
    econet,
);

const CpuClass = model.isAtom ? AtomCpu6502 : Cpu6502;
processor = new CpuClass(model, {
    dbgr,
    video,
    soundChip: audioHandler.soundChip,
    ddNoise: audioHandler.ddNoise,
    relayNoise: audioHandler.relayNoise,
    music5000: config.hasMusic5000 ? audioHandler.music5000 : null,
    cmos,
    config: emulationConfig,
    econet,
});

printer.attach(processor.uservia);
const drives = new Drives({ fdc: processor.fdc, driveTracks, areYouSure: modals.areYouSure.bind(modals) });
const media = new MediaLoader({
    processor,
    model,
    drives,
    urlState,
    config,
    modals,
    isSnapshotFile,
    loadSnapshot: (file, buffer) => snapshots.loadStateFromFile(file, buffer),
    // The archives are created further down; each source resolves when used.
    sources: {
        sth: (name) => sthPicker.discs.fetch(name),
        tapeSth: (name) => sthPicker.tapes.fetch(name),
        hfe: (path) => hfePicker.archive.fetch(path),
        drive: (cat, layout) => drivePicker.load(cat, layout),
    },
});
const autoBoot = new Autoboot({
    model,
    processor,
    sendKeys: (keysToSend, check) => keys.sendRawKeyboard(keysToSend, check),
});
const autobootTicks = new AutobootTicks({ urlState });
const sthPicker = new SthPicker({
    media,
    drives,
    modals,
    urlState,
    processor,
    autoboot: (image) => autoBoot.boot(image),
});
const hfePicker = new HfePicker({
    media,
    drives,
    modals,
    urlState,
    processor,
    autoboot: (image) => autoBoot.boot(image),
});
const drivePicker = new GoogleDrivePicker({ media, drives, modals, processor });
const snapshots = new SnapshotUI({
    processor,
    model,
    video,
    media,
    drives,
    urlState,
    modals,
    isRunning: () => loop.isRunning(),
    stop: (debug) => loop.stop(debug),
    go: () => loop.go(),
});

processor.teletextAdaptor?.addEventListener("notice", showNotice);
processor.acia.addEventListener("notice", showNotice);

// Create input sources
const inputs = new AnalogueInputs({
    processor,
    screenCanvas,
    getGamepads: emulationConfig.getGamepads,
    urlState,
    config,
    audioHandler,
});

/**
 * Attach an RS-423 composite handler to the ACIA that combines the touchscreen
 * (which sends position data to the BBC) with the speech output (which speaks
 * text the BBC sends out).
 */
function setupRs423Handler() {
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

if (parsedQuery.microphoneChannel !== undefined) {
    // We need to use setTimeout to make sure this runs after the page has loaded
    // This is needed because some browsers require user interaction for audio context
    setTimeout(async () => {
        await inputs.setupMicrophone();
    }, 1000);
}

// Apply ADC source settings from URL parameters
inputs.updateAdcSources(parsedQuery.mouseJoystickEnabled, parsedQuery.microphoneChannel);

keys.attach({ processor, dbgr, keyLayout });

document.getElementById("download-filestore-link").addEventListener("click", function () {
    downloadDriveData(processor.filestore.scsi, "scsi", ".dat");
});

function hardReset() {
    if (rewindUI) {
        rewindUI.close();
        rewindBuffer.clear();
        rewindUI.updateButtonState();
    }
    processor.reset(true);
}

document.getElementById("hard-reset").addEventListener("click", function (event) {
    hardReset();
    event.preventDefault();
});

document.getElementById("soft-reset").addEventListener("click", function (event) {
    processor.reset(false);
    event.preventDefault();
});

const frontPanel = new FrontPanel({ processor, model, printer });

const startPromise = (async () => {
    await Promise.all([audioHandler.initialise(), processor.initialise()]);

    // Wire up the composite RS-423 handler now that the touchscreen exists.
    setupRs423Handler();

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
        startImageLoad(`disc ${discImage}`, async () =>
            drives.putDiscIn(0, await media.loadDiscImage(discImage, drives.layoutForDrive(0))),
        );
    }

    if (secondDiscImage) {
        startImageLoad(`disc ${secondDiscImage}`, async () =>
            drives.putDiscIn(1, await media.loadDiscImage(secondDiscImage, drives.layoutForDrive(1))),
        );
    }

    if (parsedQuery.tape) {
        startImageLoad(`tape ${parsedQuery.tape}`, async () =>
            media.setProcessorTape(await media.loadTapeImage(parsedQuery.tape)),
        );
    }

    if (mmcImage && model.isAtom) {
        startImageLoad(`MMC image ${mmcImage}`, async () => processor.atommc.SetMMCData(await LoadSD(mmcImage)));
    }

    if (parsedQuery.loadBasic) {
        const needsRun = needsAutoboot === "run";
        needsAutoboot = "";

        await startImageLoad(`BASIC program ${parsedQuery.loadBasic}`, () =>
            autoBoot.insertBasic(
                (async () => {
                    const data = await utils.loadData(parsedQuery.loadBasic);
                    return String.fromCharCode.apply(null, data);
                })(),
                needsRun,
            ),
        );
    }

    if (parsedQuery.embedBasic) {
        await startImageLoad("the BASIC program from the URL", () =>
            autoBoot.insertBasic(Promise.resolve(parsedQuery.embedBasic), true),
        );
    }

    return Promise.all(imageLoads);
})();

(async () => {
    try {
        await startPromise;

        switch (needsAutoboot) {
            case "boot":
                autobootTicks.show(true);
                autoBoot.boot(discImage);
                break;
            case "type":
                autoBoot.type(autoType);
                break;
            case "chain":
                autoBoot.chainTape();
                break;
            case "run":
                autoBoot.runTape();
                break;
            default:
                autobootTicks.show(false);
                break;
        }

        if (parsedQuery.patch) {
            dbgr.setPatch(parsedQuery.patch);
        }

        // Restore the state a cross-model reload stashed, if there is one.
        await snapshots.restorePendingState();

        loop.go();
    } catch (error) {
        console.error("Error initialising emulator:", error);
        modals.showError("initialising", error);
    }
})();

const rewindBuffer = new RewindBuffer(30);

const loop = new EmulationLoop({
    processor,
    display,
    audioHandler,
    dbgr,
    gamepad,
    keyboard: keys,
    syncLights: () => frontPanel.syncLights(),
    rewindBuffer,
    onRewindCaptured: () => rewindUI.updateButtonState(),
    clocksPerSecond,
    cpuSpeed,
    fastTape: !!parsedQuery.fasttape,
    audioStatsNode,
});
loop.addEventListener("running", () => {
    const running = loop.isRunning();
    keys.setRunning(running);
    debugPlay.disabled = running;
    debugPause.disabled = !running;
});

rewindUI = new RewindUI({
    rewindBuffer,
    processor,
    video,
    captureInterval: RewindCaptureInterval,
    stop: (debug) => loop.stop(debug),
    go: () => loop.go(),
    isRunning: () => loop.isRunning(),
});
rewindUI.updateButtonState();

if (processor.fdc) new DiscVisualiser({ fdc: processor.fdc });
else document.getElementById("disc-visualiser-open").classList.add("disabled");

new Layout({
    screenCanvas,
    display,
    embed: parsedQuery.embed !== undefined,
    sidebars: { left: parsedQuery.sbLeft, right: parsedQuery.sbRight, bottom: parsedQuery.sbBottom },
});

if (Object.hasOwn(parsedQuery, "about")) modals.show("info");
if (Object.hasOwn(parsedQuery, "pp-tos")) modals.show("pp-tos");

// Handy shortcuts. bench/profile stuff is delayed so that they can be
// safely run from the JS console in firefox.
window.benchmarkCpu = utils.debounce((numCycles) => loop.benchmarkCpu(numCycles), 1);
window.profileCpu = utils.debounce((arg) => loop.profileCpu(arg), 1);
window.benchmarkVideo = utils.debounce((numCycles) => loop.benchmarkVideo(numCycles), 1);
window.profileVideo = utils.debounce((arg) => loop.profileVideo(arg), 1);
window.go = () => loop.go();
window.stop = (debug) => loop.stop(debug);
window.soundChip = audioHandler.soundChip;
window.processor = processor;
window.video = video;
window.hd = function (start, end) {
    console.log(
        utils.hd(
            function (x) {
                return processor.readmem(x);
            },
            start,
            end,
        ),
    );
};
window.m7dump = function () {
    console.log(
        utils.hd(
            function (x) {
                return processor.readmem(x) & 0x7f;
            },
            0x7c00,
            0x7fe8,
            { width: 40, gap: false },
        ),
    );
};

// Hooks for electron.
electron({
    loadDiscImage: media.loadDiscImage.bind(media),
    loadTapeImage: media.loadTapeImage.bind(media),
    processor,
    config,
    modals: {
        show: (modalId, sthType) => {
            if (modalId === "sth" && sthType) {
                if (sthType === "discs") sthPicker.discs.populate();
                else if (sthType === "tapes") sthPicker.tapes.populate();
            }
            modals.show(modalId);
        },
    },
    loadStateFile: snapshots.loadStateFromFile.bind(snapshots),
    actions: {
        "soft-reset": () => processor.reset(false),
        "hard-reset": hardReset,
        "save-state": () => document.getElementById("save-state").click(),
        rewind: () => rewindUI.open(),
        pause: pauseIntoDebugger,
        resume: resumeFromDebugger,
    },
});

// Display version in About dialog
const versionElement = document.getElementById("jsbeeb-version");
if (versionElement) {
    versionElement.textContent = `Version ${version}`;
}
