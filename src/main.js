import { version } from "../package.json";

import "bootswatch/dist/darkly/bootstrap.min.css";
import "./jsbeeb.css";

import * as utils from "./utils.js";
import { Debugger } from "./web/debug.js";
import * as utils_atom from "./utils_atom.js";
import { GamePad } from "./gamepads.js";
import { initialise as electron } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { QuickSettings } from "./web/quick-settings.js";
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
import { Machine } from "./web/machine.js";
import { Drives } from "./web/drives.js";
import { UrlState } from "./web/url-state.js";
import { Modals } from "./web/modals.js";
import { Settings } from "./web/settings.js";
import { Printer } from "./printer.js";
import { RewindBuffer } from "./rewind.js";
import { RewindUI } from "./web/rewind-ui.js";
import { DiscVisualiser } from "./web/disc-visualiser.js";
import { downloadDriveData } from "./dom-utils.js";
import { parseMediaParams, processAutobootParams, processDriveTrackParams, processInputParams } from "./url-params.js";

// ------------------------------------------------------------------------
// What the URL asked for.
// ------------------------------------------------------------------------

const urlState = new UrlState(window.location, window.history);
const parsedQuery = urlState.params;
let { needsAutoboot, autoType } = processAutobootParams(parsedQuery);

let discImage = BuiltInImages[0].file;
let secondDiscImage = null;
const { discImage: queryDiscImage, secondDiscImage: querySecondDisc, mmcImage } = parseMediaParams(parsedQuery);
if (queryDiscImage) discImage = queryDiscImage;
if (querySecondDisc) secondDiscImage = querySecondDisc;
const { settings: driveTracks, warnings: driveTrackWarnings } = processDriveTrackParams(parsedQuery);

const extraRoms = [];
if (Array.isArray(parsedQuery.rom)) {
    parsedQuery.rom.forEach((romPath) => {
        if (romPath) extraRoms.push(romPath);
    });
}

const cpuMultiplier = parsedQuery.cpuMultiplier ?? 1;
const noSeek = !!parsedQuery.noseek;
const stationId = parsedQuery.stationId !== undefined ? parsedQuery.stationId : 101;

let tryGl = true;
if (parsedQuery.glEnabled !== undefined) {
    tryGl = parsedQuery.glEnabled === "true";
}
let lowLatency = true;
if (parsedQuery.lowLatency !== undefined) {
    lowLatency = parsedQuery.lowLatency === "true";
}

if (parsedQuery.embed) {
    for (const el of document.querySelectorAll(".embed-hide")) el.style.display = "none";
    document.body.style.backgroundColor = "transparent";
}

// ------------------------------------------------------------------------
// The pieces that exist before the machine: settings, screen, sound.
// ------------------------------------------------------------------------

const dbgr = new Debugger();

const gamepad = new GamePad();
if (!window.isSecureContext)
    toast("Gamepads only work over https, so any joystick plugged in here is not seen.", {
        title: "Gamepads",
        quietKey: "quietInsecureGamepads",
    });

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

const settings = new Settings({ urlState });
const { config, speechOutput, keyLayout, displayMode, audioOutput, speakerAmount } = settings;
const model = settings.model;

// Must come after we know the model, to validate names against those of the hardware.
const keyMappingWarnings = processInputParams(
    parsedQuery,
    model.isAtom ? utils_atom.ATOM : utils.BBC,
    utils.keyCodes,
    utils.userKeymap,
    gamepad,
);
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

if (cpuMultiplier !== 1) console.log(`CPU multiplier set to ${cpuMultiplier}`);
const cpuSpeed = model.cyclesPerSecond;
const clocksPerSecond = (cpuMultiplier * cpuSpeed) | 0;

const screenCanvas = document.getElementById("screen");
const display = new Display({
    screenCanvas,
    model,
    mode: displayMode,
    tryGl,
    lowLatency,
    fakeVideo: parsedQuery.fakeVideo !== undefined,
    frameSkip: parsedQuery.frameSkip ?? 0,
});
const video = display.video;

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
    {
        onAudioOutput: (output) => settings.applyAudioOutput(output),
        onSpeakerAmount: (amount) => settings.applySpeakerAmount(amount),
        onDisplayMode: (mode) => settings.applyDisplayMode(mode),
    },
    { audioOutput, speakerAmount, displayMode },
);

// ------------------------------------------------------------------------
// The machine, and everything that feeds it.
// ------------------------------------------------------------------------

// Depends on the settings having applied the URL parameters.
const machine = new Machine({
    model,
    config,
    parsedQuery,
    keyLayout,
    cpuMultiplier,
    extraRoms,
    stationId,
    userPort: keys.userPort,
    printer,
    speechOutput,
    video,
    audioHandler,
    dbgr,
});
const processor = machine.processor;

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

const debugPause = document.getElementById("debug-pause");
const debugPlay = document.getElementById("debug-play");
loop.addEventListener("running", () => {
    const running = loop.isRunning();
    keys.setRunning(running);
    debugPlay.disabled = running;
    debugPause.disabled = !running;
});

const modals = new Modals({ loop });

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
    loop,
});

const inputs = new AnalogueInputs({
    processor,
    screenCanvas,
    getGamepads: machine.emulationConfig.getGamepads,
    urlState,
    config,
    audioHandler,
});
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

const frontPanel = new FrontPanel({ processor, model, printer });

// ------------------------------------------------------------------------
// Running it: the loop, rewind and the visualiser.
// ------------------------------------------------------------------------

const rewindUI = new RewindUI({
    rewindBuffer,
    processor,
    video,
    captureInterval: RewindCaptureInterval,
    loop,
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

// Everything a setting can reach now exists.
settings.wire({ audioHandler, display, quickSettings, machine, keys, inputs, modals });

// ------------------------------------------------------------------------
// The page's own handlers.
// ------------------------------------------------------------------------

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

document.getElementById("download-filestore-link").addEventListener("click", function () {
    downloadDriveData(processor.filestore.scsi, "scsi", ".dat");
});

if (Object.hasOwn(parsedQuery, "about")) modals.show("info");
if (Object.hasOwn(parsedQuery, "pp-tos")) modals.show("pp-tos");

// ------------------------------------------------------------------------
// Start it up.
// ------------------------------------------------------------------------

const basicNeedsRun = parsedQuery.loadBasic !== undefined && needsAutoboot === "run";
if (parsedQuery.loadBasic) needsAutoboot = "";
const startPromise = machine.start({
    media,
    drives,
    autoBoot,
    discImage,
    secondDiscImage,
    tape: parsedQuery.tape,
    mmcImage,
    loadBasic: parsedQuery.loadBasic,
    embedBasic: parsedQuery.embedBasic,
    basicNeedsRun,
});

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

// ------------------------------------------------------------------------
// The console surface the wiki documents, and the desktop app's hooks.
// ------------------------------------------------------------------------

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
