import { version } from "../package.json";

import "bootswatch/dist/darkly/bootstrap.min.css";
import "./jsbeeb.css";

import * as utils from "./utils.js";
import { FakeVideo, Video } from "./video.js";
import { Debugger } from "./web/debug.js";
import { Cpu6502, AtomCpu6502 } from "./6502.js";
import * as utils_atom from "./utils_atom.js";
import { LoadSD } from "./mmc.js";
import { Cmos, localStoragePersistence } from "./cmos.js";
import { GamePad } from "./gamepads.js";
import * as disc from "./fdc.js";
import * as tokeniser from "./basic-tokenise.js";
import * as canvasLib from "./canvas.js";
import { Config } from "./config.js";
import { DefaultModel, findModel, tubeModelFor } from "./models.js";
import { initialise as electron } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { DefaultAudioOutput, isAudioOutput } from "./audio-output.js";
import { QuickSettings } from "./web/quick-settings.js";
import { Econet } from "./econet.js";
import { DiscLayout } from "./disc.js";
import { Keyboard } from "./keyboard.js";
import { GamepadSource } from "./gamepad-source.js";
import { toast } from "./web/toast.js";
import { BuiltInImages, MediaLoader } from "./web/media-loader.js";
import { AutobootTicks } from "./web/archive-list.js";
import { SthPicker } from "./web/sth-picker.js";
import { HfePicker } from "./web/hfe-picker.js";
import { GoogleDrivePicker } from "./web/google-drive-picker.js";
import { Drives } from "./web/drives.js";
import { UrlState } from "./web/url-state.js";
import { Modals } from "./web/modals.js";
import { errorText, reportLoadFailure, showNotice } from "./web/reporting.js";
import { MicrophoneInput } from "./microphone-input.js";
import { SpeechOutput } from "./speech-output.js";
import { Printer } from "./printer.js";
import { MouseJoystickSource } from "./mouse-joystick-source.js";
import { calculateMouseCoordinates } from "./mouse-coordinates.js";
import { getFilterForMode } from "./canvas.js";
import {
    createSnapshot,
    restoreSnapshot,
    snapshotToJSON,
    snapshotFromJSON,
    isSameModel,
    hasCoProcessor,
} from "./snapshot.js";
import { isBemSnapshot, parseBemSnapshot } from "./bem-snapshot.js";
import { isUefSnapshot, parseUefSnapshot } from "./uef-snapshot.js";
import { RewindBuffer } from "./rewind.js";
import { RewindUI } from "./rewind-ui.js";
import { DiscVisualiser } from "./disc-visualiser.js";
import { downloadBlob, downloadDriveData } from "./dom-utils.js";
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
let frames = 0;
let frameSkip = 0;
let syncLights;
let running;
let model;

// Convert text to machine-appropriate key sequences (BBC or Atom)
function stringToMachineKeys(text) {
    return model.isAtom ? utils_atom.stringToATOMKeys(text) : utils.stringToBBCKeys(text);
}

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
let fastAsPossible = false;
let fastTape = false;
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

fastTape = !!parsedQuery.fasttape;
noSeek = !!parsedQuery.noseek;

if (parsedQuery.stationId !== undefined) stationId = parsedQuery.stationId;
if (parsedQuery.frameSkip !== undefined) frameSkip = parsedQuery.frameSkip;

const printer = new Printer({
    onOutput: (char) => {
        if (printerTextArea) printerTextArea.value += char;
    },
    onFirstOutput: () =>
        toast("Printer output is being kept. Press Ctrl-B to open the printer window.", {
            title: "Printer",
            quietKey: "quietPrinterOutput",
        }),
});

// Accessibility switch state — bits 0-7 correspond to switches 1-8.
// Active low: 0xff = no switches pressed; clearing a bit = that switch is pressed.
let switchState = 0xff;

const userPort = {
    write() {},
    read() {
        return switchState;
    },
};

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
            keyboard.setKeyLayout(changed.keyLayout);
        }
        if (changed.mouseJoystickEnabled !== undefined || changed.microphoneChannel !== undefined) {
            updateAdcSources(parsedQuery.mouseJoystickEnabled, parsedQuery.microphoneChannel);

            if (changed.microphoneChannel !== undefined) {
                setupMicrophone();
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
    // swapCanvas settles displayModeFilter on whatever was really
    // built, so take the picture from that rather than the request.
    swapCanvas(getFilterForMode(mode));
    setCrtPic(displayModeFilter);
    // Trigger window resize to recalculate layout with new dimensions
    window.dispatchEvent(new Event("resize"));
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

function sbBind(div, url, onload) {
    const img = div.querySelector("img");
    img.style.display = "none";
    if (!url) return;
    img.addEventListener("load", function () {
        onload(div, img);
        img.style.display = "";
    });
    img.src = url;
}

sbBind(document.querySelector(".sidebar.left"), parsedQuery.sbLeft, function (div, img) {
    div.style.left = -img.naturalWidth - 5 + "px";
});
sbBind(document.querySelector(".sidebar.right"), parsedQuery.sbRight, function (div, img) {
    div.style.right = -img.naturalWidth - 5 + "px";
});
sbBind(document.querySelector(".sidebar.bottom"), parsedQuery.sbBottom, function (div, img) {
    div.style.bottom = -img.naturalHeight + "px";
});

if (cpuMultiplier !== 1) console.log(`CPU multiplier set to ${cpuMultiplier}`);
const cpuSpeed = model.cyclesPerSecond;
const clocksPerSecond = (cpuMultiplier * cpuSpeed) | 0;
const MaxCyclesPerTick = clocksPerSecond / 10;

let tryGl = true;
if (parsedQuery.glEnabled !== undefined) {
    tryGl = parsedQuery.glEnabled === "true";
}
let lowLatency = true;
if (parsedQuery.lowLatency !== undefined) {
    lowLatency = parsedQuery.lowLatency === "true";
}
const screenCanvas = document.getElementById("screen");

const modals = new Modals({ isRunning: () => running, stop, go });

async function compressBlob(blob) {
    const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).blob();
}

async function decompressBlob(blob) {
    const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).blob();
}

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

// Test which filter is actually in use, not merely whether we got WebGL: a
// filter can decline a context that works perfectly well for other modes, in
// which case we are quietly left with an unfiltered display.
function reportAnyFallback(displayCanvas, filterClass) {
    if (displayCanvas.filterClass === filterClass) return;
    const reason = displayCanvas.fallbackReason ? ` (${displayCanvas.fallbackReason})` : "";
    const { name } = filterClass.getDisplayConfig();
    toast(`${name} is not available on this device, so the standard display is in use${reason}.`, {
        title: "Display",
        quietKey: "quietDisplayFallback",
    });
}

function sizeCanvasFor(filterClass) {
    // Not `config`: that is the emulator's live configuration object, declared
    // at module scope and used throughout this file.
    const displayConfig = filterClass.getDisplayConfig();
    if (screenCanvas.width === displayConfig.canvasWidth && screenCanvas.height === displayConfig.canvasHeight) return;
    screenCanvas.width = displayConfig.canvasWidth;
    screenCanvas.height = displayConfig.canvasHeight;
}

function createCanvasForFilter(filterClass) {
    // Each mode says how many pixels it wants to draw into. Set this before
    // creating the context, which fixes its initial viewport.
    sizeCanvasFor(filterClass);

    const newCanvas = tryGl
        ? canvasLib.bestCanvas(screenCanvas, filterClass, lowLatency)
        : new canvasLib.Canvas(screenCanvas, lowLatency);
    reportAnyFallback(newCanvas, filterClass);
    return newCanvas;
}

let displayModeFilter = canvasLib.getFilterForMode(displayMode);
function swapCanvas(newFilterClass) {
    // Everything but the filter is the same whatever the mode: the framebuffer
    // texture, the vertex buffers and fb32 all carry over untouched.
    canvasLib.useBestFilter(canvas, newFilterClass);
    reportAnyFallback(canvas, newFilterClass);
    // Follow the filter we ended up with, not the one we asked for: everything
    // downstream (the monitor picture, the canvas geometry, how large a drawing
    // buffer to ask for) comes from its display config.
    displayModeFilter = canvas.filterClass;
    // Back to the mode's own size, undoing any scaling the last one asked for.
    sizeCanvasFor(displayModeFilter);
    // Nothing else will redraw: the mode is changed from a modal, which stops
    // the emulator.
    video.paint();
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 1);
}

const canvas = createCanvasForFilter(displayModeFilter);
displayModeFilter = canvas.filterClass;

// The emulator paints into its own framebuffer; flyback copies the finished
// frame into the canvas and an animation frame presents it, so a stalled
// display holds up the picture and not the emulation (issue #885).
const videoFb32 = new Uint32Array(canvas.fb32.length);
const pendingFrame = {
    minx: 0,
    miny: 0,
    maxx: 0,
    maxy: 0,
    lineBaseEven: 0,
    lineBaseOdd: 0,
    lineGrid: new Uint8Array(0),
};
let presentScheduled = false;
let paintMsThisTick = 0;
let presentMsMax = 0;

function present() {
    presentScheduled = false;
    const start = performance.now();
    canvas.paint(pendingFrame.minx, pendingFrame.miny, pendingFrame.maxx, pendingFrame.maxy, pendingFrame);
    presentMsMax = Math.max(presentMsMax, performance.now() - start);
}

video = new Video(
    model.isMaster,
    videoFb32,
    function paint(minx, miny, maxx, maxy) {
        frames++;
        if (frames < frameSkip) return;
        frames = 0;
        const start = performance.now();
        canvas.fb32.set(videoFb32.subarray(miny * 1024, maxy * 1024), miny * 1024);
        if (pendingFrame.lineGrid.length !== this.lineGrid.length)
            pendingFrame.lineGrid = new Uint8Array(this.lineGrid.length);
        pendingFrame.lineGrid.set(this.lineGrid);
        Object.assign(pendingFrame, {
            minx,
            miny,
            maxx,
            maxy,
            lineBaseEven: this.lineBaseEven,
            lineBaseOdd: this.lineBaseOdd,
        });
        paintMsThisTick += performance.now() - start;
        if (!presentScheduled) {
            presentScheduled = true;
            window.requestAnimationFrame(present);
        }
    },
    { isAtom: model.isAtom },
);
if (parsedQuery.fakeVideo !== undefined) video = new FakeVideo();

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
    sendRawKeyboard(stringToMachineKeys(text), true);
});
const cubMonitor = document.getElementById("cub-monitor");
function onCubMouseEvent(evt) {
    audioHandler.tryResume();
    if (document.activeElement !== document.body) document.activeElement.blur();
    const screenRect = screenCanvas.getBoundingClientRect();
    const { x, y } = calculateMouseCoordinates(evt, screenRect);

    // Handle touchscreen
    if (processor.touchScreen) processor.touchScreen.onMouse(x, y, evt.buttons);

    // Handle mouse joystick if enabled
    if (parsedQuery.mouseJoystickEnabled && mouseJoystickSource.isEnabled()) {
        // Use the API methods instead of direct manipulation
        mouseJoystickSource.onMouseMove(x, y);

        // Handle button events
        if (evt.type === "mousedown" && evt.button === 0) {
            mouseJoystickSource.onMouseDown(0);
        } else if (evt.type === "mouseup" && evt.button === 0) {
            mouseJoystickSource.onMouseUp(0);
        }
    }

    evt.preventDefault();
}
for (const eventType of ["mousemove", "mousedown", "mouseup"]) {
    cubMonitor.addEventListener(eventType, onCubMouseEvent);
}

function setCrtPic(filterMode) {
    const config = filterMode.getDisplayConfig();
    const monitorPic = document.getElementById("cub-monitor-pic");
    monitorPic.src = config.image;
    monitorPic.alt = config.imageAlt;
    monitorPic.width = config.imageWidth;
    monitorPic.height = config.imageHeight;
}
setCrtPic(displayModeFilter);

window.addEventListener("blur", function () {
    keyboard.clearKeys();
    setEmulationLead(audioHandler.setWindowFocused(false));
});
window.addEventListener("focus", () => setEmulationLead(audioHandler.setWindowFocused(true)));

const fullscreenItem = document.getElementById("fs");
if (document.fullscreenEnabled) {
    fullscreenItem.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
            await screenCanvas.requestFullscreen();
        } catch (error) {
            toast(`Could not go fullscreen: ${errorText(error)}`, { title: "Fullscreen" });
        }
    });
} else {
    fullscreenItem.closest("li").hidden = true;
}

let keyboard; // This will be initialised after the processor is created

const debugPause = document.getElementById("debug-pause");
const debugPlay = document.getElementById("debug-play");

function pauseIntoDebugger() {
    stop(true);
}

function resumeFromDebugger() {
    dbgr.hide();
    keyboard.resumeEmulation();
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
    if (running && processor.sysvia.hasAnyKeyDown()) {
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

let printerWindow = null;
let printerTextArea = null;

function checkPrinterWindow() {
    if (printerWindow && !printerWindow.closed) return;

    printerWindow = window.open("", "_blank", "height=300,width=400");
    if (!printerWindow) {
        toast("The printer output window was blocked. Allow pop-up windows for this site, then press Ctrl-B again.", {
            title: "Printer",
        });
        return;
    }
    printerWindow.document.write(
        '<textarea id="text" rows="15" cols="40" placeholder="Printer outputs here..."></textarea>',
    );
    printerTextArea = printerWindow.document.getElementById("text");
    printerTextArea.value = printer.text;
}

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
    loadSnapshot: (file, buffer) => loadStateFromFile(file, buffer),
    // The archives are created further down; each source resolves when used.
    sources: {
        sth: (name) => sthPicker.discs.fetch(name),
        tapeSth: (name) => sthPicker.tapes.fetch(name),
        hfe: (path) => hfePicker.archive.fetch(path),
        drive: (cat, layout) => drivePicker.load(cat, layout),
    },
});
const autobootTicks = new AutobootTicks({ urlState });
const sthPicker = new SthPicker({ media, drives, modals, urlState, processor, autoboot });
const hfePicker = new HfePicker({ media, drives, modals, urlState, processor, autoboot });
const drivePicker = new GoogleDrivePicker({ media, drives, modals, processor });

processor.teletextAdaptor?.addEventListener("notice", showNotice);
processor.acia.addEventListener("notice", showNotice);

// Create input sources
const gamepadSource = new GamepadSource(emulationConfig.getGamepads);
// Create MicrophoneInput but don't enable by default
const microphoneInput = new MicrophoneInput();
microphoneInput.setErrorCallback((message) => {
    toast(`${message} The microphone channel has been turned off.`, { title: "Microphone" });
});

// Create MouseJoystickSource but don't enable by default
const mouseJoystickSource = new MouseJoystickSource(screenCanvas);

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

// Helper to manage ADC source configuration
function updateAdcSources(mouseJoystickEnabled, microphoneChannel) {
    // Default all channels to the gamepad source.
    for (let ch = 0; ch < 4; ch++) {
        processor.adconverter.setChannelSource(ch, gamepadSource);
    }

    // Apply mouse joystick if enabled (takes priority on channels 0 & 1)
    if (mouseJoystickEnabled) {
        processor.adconverter.setChannelSource(0, mouseJoystickSource);
        processor.adconverter.setChannelSource(1, mouseJoystickSource);
        mouseJoystickSource.setVia(processor.sysvia);
    } else {
        mouseJoystickSource.setVia(null);
    }

    // Apply microphone if configured (can override any channel)
    if (microphoneChannel !== undefined) {
        processor.adconverter.setChannelSource(microphoneChannel, microphoneInput);
    }
}

async function ensureMicrophoneRunning() {
    if (microphoneInput.audioContext && microphoneInput.audioContext.state !== "running") {
        try {
            await microphoneInput.audioContext.resume();
            console.log("Microphone: Audio context resumed, new state:", microphoneInput.audioContext.state);
        } catch (err) {
            console.error("Microphone: Error resuming audio context:", err);
            return false;
        }
    }
    return true;
}

async function setupMicrophone() {
    const micPermissionStatus = document.getElementById("micPermissionStatus");
    micPermissionStatus.textContent = "Requesting microphone access...";

    // Try to initialise the microphone
    const success = await microphoneInput.initialise();
    if (success) {
        // Note: Channel assignment is handled by updateAdcSources()
        micPermissionStatus.textContent = "Microphone connected successfully";
        await ensureMicrophoneRunning();

        // Try starting audio context from user gesture
        const tryAgain = async () => {
            if (await ensureMicrophoneRunning()) document.removeEventListener("click", tryAgain);
        };
        document.addEventListener("click", tryAgain);
    } else {
        micPermissionStatus.textContent = `Error: ${microphoneInput.getErrorMessage() || "Unknown error"}`;
        config.setMicrophoneChannel(undefined);
        // Update URL to remove the parameter
        delete parsedQuery.microphoneChannel;
        urlState.updateUrl();
    }
}

if (parsedQuery.microphoneChannel !== undefined) {
    // We need to use setTimeout to make sure this runs after the page has loaded
    // This is needed because some browsers require user interaction for audio context
    setTimeout(async () => {
        await setupMicrophone();
    }, 1000);
}

// Apply ADC source settings from URL parameters
updateAdcSources(parsedQuery.mouseJoystickEnabled, parsedQuery.microphoneChannel);

// Initialise keyboard now that processor exists
keyboard = new Keyboard({
    processor,
    inputEnabledFunction: () => document.activeElement && document.activeElement.id === "paste-text",
    keyLayout,
    dbgr,
});
keyboard.addEventListener("notice", showNotice);
keyboard.addEventListener("pause", () => stop(false));
keyboard.addEventListener("resume", () => go());
keyboard.addEventListener("break", (e) => {
    // F12/Break: Reset processor
    if (e.detail) utils.noteEvent("keyboard", "press", "break");
});

// Register default key handlers
keyboard.registerKeyHandler(
    utils.keyCodes.S,
    (down) => {
        if (down) {
            utils.noteEvent("keyboard", "press", "S");
            stop(true);
        }
    },
    { alt: true, ctrl: false },
);

keyboard.registerKeyHandler(
    utils.keyCodes.R,
    (down) => {
        if (down) window.location.reload();
    },
    { alt: true, ctrl: false },
);

// Register Ctrl key handlers
keyboard.registerKeyHandler(
    utils.keyCodes.HOME,
    (down) => {
        if (down) {
            utils.noteEvent("keyboard", "press", "home");
            stop(true);
        }
    },
    { alt: false, ctrl: true },
);

keyboard.registerKeyHandler(
    utils.keyCodes.INSERT,
    (down) => {
        if (down) {
            utils.noteEvent("keyboard", "press", "insert");
            fastAsPossible = !fastAsPossible;
        }
    },
    { alt: false, ctrl: true },
);

keyboard.registerKeyHandler(
    utils.keyCodes.END,
    (down) => {
        if (down) {
            utils.noteEvent("keyboard", "press", "end");
            keyboard.pauseEmulation();
        }
    },
    { alt: false, ctrl: true },
);

keyboard.registerKeyHandler(
    utils.keyCodes.PAGEDOWN,
    (down) => {
        if (down) {
            utils.noteEvent("keyboard", "press", "pagedown");
            if (rewindUI) rewindUI.open();
        }
    },
    { alt: true, ctrl: false },
);

keyboard.registerKeyHandler(
    utils.keyCodes.B,
    (down) => {
        if (down) {
            checkPrinterWindow();
        }
    },
    { alt: false, ctrl: true },
);

// Register accessibility switch key handlers.
// Keys 1–8 (K1–K8) and function keys F1–F8 both map to user port bits 0–7
// (active low: pressing the key clears the corresponding bit in &FE60).
//
// On real hardware, the Brilliant Computing switch interface box and special-ed
// joystick connect to the User Port only — they do not touch the analogue port
// or the System VIA fire buttons (PB4/PB5), which belong to the standard
// analogue joystick connector.  So we only update switchState here.
{
    const handleSwitch = (bit) => (down) => {
        if (down) switchState &= ~(1 << bit);
        else switchState |= 1 << bit;
    };

    // Alt+1–8 and Alt+F1–F8 trigger the switches.  Using Alt means the underlying
    // key is never forwarded to the BBC Micro (keyboard.js bails out early when a
    // handler fires), so typing numbers or using function keys works normally.
    const altMod = { alt: true, ctrl: false };
    for (let i = 0; i < 8; i++) {
        keyboard.registerKeyHandler(utils.keyCodes.K1 + i, handleSwitch(i), altMod);
        keyboard.registerKeyHandler(utils.keyCodes.F1 + i, handleSwitch(i), altMod);
    }
}

// Setup key handlers
document.addEventListener("keydown", (evt) => {
    audioHandler.tryResume();
    ensureMicrophoneRunning();
    keyboard.keyDown(evt);
});
document.addEventListener("keypress", (evt) => keyboard.keyPress(evt));
document.addEventListener("keyup", (evt) => keyboard.keyUp(evt));

function sendRawKeyboard(keysToSend, checkCapsAndShiftLocks) {
    if (keyboard) {
        keyboard.sendRawKeyboard(keysToSend, checkCapsAndShiftLocks);
    } else {
        console.warn("Tried to send keys before keyboard was initialised");
    }
}

function autoboot(image) {
    const BBC = utils.BBC;

    console.log("Autobooting disc");
    utils.noteEvent("init", "autoboot", image);

    // Shift-break simulation, hold SHIFT for 1000ms.
    sendRawKeyboard([BBC.SHIFT, 1000], false);
}

function autoBootType(keys) {
    console.log("Auto typing '" + keys + "'");
    utils.noteEvent("init", "autochain");

    const bbcKeys = stringToMachineKeys(keys);
    sendRawKeyboard([1000].concat(bbcKeys), false);
}

function autoChainTape() {
    console.log("Auto Chaining Tape");
    utils.noteEvent("init", "autochain");

    const bbcKeys = stringToMachineKeys('*TAPE\nCH.""\n');
    sendRawKeyboard([1000].concat(bbcKeys), false);
}

function autoRunTape() {
    console.log("Auto Running Tape");
    utils.noteEvent("init", "autorun");

    const bbcKeys = stringToMachineKeys("*TAPE\n*/\n");
    sendRawKeyboard([1000].concat(bbcKeys), false);
}

function autoRunBasic() {
    console.log("Auto Running basic");
    utils.noteEvent("init", "autorunbasic");

    const bbcKeys = stringToMachineKeys("RUN\n");
    sendRawKeyboard([1000].concat(bbcKeys), false);
}

async function reloadSnapshotMedia(savedMedia) {
    if (!savedMedia) return;
    for (let driveIndex = 0; driveIndex < 2; driveIndex++) {
        const discKey = driveIndex === 0 ? "disc1" : "disc2";
        const imageDataKey = discKey + "ImageData";
        const crcKey = discKey + "Crc32";

        // A snapshot from before layout detection has no field, and was contiguous.
        const layout = savedMedia[discKey + "Layout"] ?? DiscLayout.contiguous;

        let loadedDisc = null;
        if (savedMedia[discKey]) {
            // URL-based disc — reload from source
            loadedDisc = await media.loadDiscImage(savedMedia[discKey], layout);
        } else if (savedMedia[imageDataKey]) {
            // Locally-loaded disc — reconstruct from embedded image data
            const imageData =
                savedMedia[imageDataKey] instanceof Uint8Array
                    ? savedMedia[imageDataKey]
                    : new Uint8Array(Object.values(savedMedia[imageDataKey]));
            const discName = savedMedia[discKey + "Name"] || "snapshot.ssd";
            loadedDisc = disc.discFor(processor.fdc, discName, imageData, undefined, layout);
            // Retain the image bytes so subsequent saves can re-embed them.
            loadedDisc.setOriginalImage(imageData);
        }
        if (!loadedDisc) continue;

        // Verify CRC32 if present
        if (savedMedia[crcKey] != null && loadedDisc.originalImageCrc32 != null) {
            if (loadedDisc.originalImageCrc32 !== savedMedia[crcKey]) {
                toast(
                    `${loadedDisc.name} has changed since this state was saved. The state has been restored anyway and may not run correctly.`,
                    { title: "Restoring state" },
                );
            }
        }

        drives.putDiscIn(driveIndex, loadedDisc);
        // Only update the URL/query for URL-sourced discs. For embedded
        // (local-file) discs, setting parsedQuery would put a bogus source
        // in the URL and break subsequent saves/reloads.
        if (savedMedia[discKey]) {
            if (driveIndex === 0) media.setDisc1Image(savedMedia[discKey]);
            else media.setDisc2Image(savedMedia[discKey]);
        }
    }
}

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

document.getElementById("save-state").addEventListener("click", async function (event) {
    event.preventDefault();
    const wasRunning = running;
    if (running) stop(false);
    try {
        const media = {};
        if (parsedQuery.disc1 || parsedQuery.disc) media.disc1 = parsedQuery.disc1 || parsedQuery.disc;
        if (parsedQuery.disc2) media.disc2 = parsedQuery.disc2;

        // For each drive with a disc loaded, include CRC32 for verification
        // and embed original image data if no URL source exists (local file).
        const drives = processor.fdc.drives;
        for (let driveIndex = 0; driveIndex < 2; driveIndex++) {
            const driveDisc = drives[driveIndex].disc;
            if (!driveDisc || driveDisc.originalImageCrc32 == null) continue;
            const discKey = driveIndex === 0 ? "disc1" : "disc2";
            const crcKey = discKey + "Crc32";
            media[crcKey] = driveDisc.originalImageCrc32;
            // The snapshot's dirty tracks are indexed by physical track, so restoring has to lay
            // the disc out the way this one was rather than work it out again.
            media[discKey + "Layout"] = driveDisc.is40Track ? DiscLayout.expanded40 : DiscLayout.contiguous;
            if (!media[discKey] && driveDisc.originalImageData) {
                media[discKey + "ImageData"] = driveDisc.originalImageData;
                media[discKey + "Name"] = driveDisc.name;
            }
        }

        const snapshot = createSnapshot(processor, model, Object.keys(media).length > 0 ? media : undefined);
        const json = snapshotToJSON(snapshot);
        const blob = await compressBlob(new Blob([json]));
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(blob, `jsbeeb-${model.name}-${timestamp}.json.gz`);
    } catch (e) {
        modals.showError("saving state", e);
    }
    if (wasRunning) go();
});

async function loadStateFromFile(file, preReadBuffer) {
    const wasRunning = running;
    if (running) stop(false);
    try {
        const arrayBuffer = preReadBuffer || (await file.arrayBuffer());
        let snapshot;
        if (isBemSnapshot(arrayBuffer)) {
            snapshot = await parseBemSnapshot(arrayBuffer);
        } else if (isUefSnapshot(arrayBuffer)) {
            snapshot = parseUefSnapshot(arrayBuffer);
        } else {
            // Detect gzip (magic bytes 0x1f 0x8b) or plain JSON
            const bytes = new Uint8Array(arrayBuffer);
            let text;
            if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
                const decompressed = await decompressBlob(new Blob([arrayBuffer]));
                text = await decompressed.text();
            } else {
                text = new TextDecoder().decode(arrayBuffer);
            }
            snapshot = snapshotFromJSON(text);
        }
        if (!isSameModel(snapshot.model, model.name) || hasCoProcessor(snapshot) !== processor.hasTube) {
            // Model or co-processor mismatch: stash state and reload with a matching machine
            sessionStorage.setItem("jsbeeb-pending-state", snapshotToJSON(snapshot));
            window.location.href = urlState.urlWith({ model: snapshot.model, coProcessor: hasCoProcessor(snapshot) });
            return;
        }
        // Order matters: reload disc media first so the base disc is in the
        // drive before restoreSnapshot applies dirty track overlays on top.
        await reloadSnapshotMedia(snapshot.media);
        restoreSnapshot(processor, model, snapshot);
        // Force a repaint so the display updates even while paused
        video.paint();
    } catch (e) {
        modals.showError("loading state", e);
    }
    if (wasRunning) go();
}

function isSnapshotFile(filename, arrayBuffer) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".snp") || lower.endsWith(".json") || lower.endsWith(".json.gz") || lower.endsWith(".gz"))
        return true;
    // .uef can be either a BeebEm save state or a regular tape image - check content
    if (lower.endsWith(".uef") && arrayBuffer) return isUefSnapshot(arrayBuffer);
    return false;
}

document.getElementById("load-state").addEventListener("change", async function (event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = "";
    await loadStateFromFile(file);
});

for (const link of document.querySelectorAll("#tape-menu a")) {
    link.addEventListener("click", function (e) {
        const type = e.target.dataset.id;
        if (type === undefined) return;

        if (type === "rewind") {
            console.log("Rewinding tape to the start");
            if (model.isAtom) {
                processor.atomppia.stopTape();
                processor.atomppia.rewindTape();
                updateTapeButton();
            } else {
                processor.acia.rewindTape();
            }
        } else {
            console.log("unknown type", type);
        }
    });
}

const tapePlayStopBtn = document.getElementById("tape-play-stop");
const tapeControlHeader = document.getElementById("tape-control-header");
const tapeControlCell = document.getElementById("tape-control-cell");

function updateTapeButton() {
    if (!model.isAtom) return;
    const playing = processor.atomppia.motorOn;
    const label = playing ? "Stop cassette" : "Play cassette";
    tapePlayStopBtn.textContent = playing ? "\u25A0" : "\u25B6";
    tapePlayStopBtn.title = label;
    tapePlayStopBtn.setAttribute("aria-label", label);
    tapePlayStopBtn.classList.toggle("playing", playing);
}

function showTapeControl(visible) {
    const display = visible ? "" : "none";
    tapeControlHeader.style.display = display;
    tapeControlCell.style.display = display;
}

function updateLedVisibility() {
    const bbcDisplay = model.isAtom ? "none" : "";
    for (const el of document.querySelectorAll(".bbc-only")) {
        el.style.display = bbcDisplay;
    }
    showTapeControl(model.isAtom);
}

updateLedVisibility();

tapePlayStopBtn.addEventListener("click", () => {
    if (processor.atomppia.motorOn) {
        processor.atomppia.stopTape();
    } else {
        processor.atomppia.playTape();
    }
    updateTapeButton();
});

function Light(name) {
    const dom = document.getElementById(name);
    let on = false;
    this.update = function (val) {
        if (val === on) return;
        on = val;
        dom.classList.toggle("on", on);
    };
}

const cassette = new Light("motorlight");
const caps = new Light("capslight");
const shift = new Light("shiftlight");
const drive0 = new Light("drive0");
const drive1 = new Light("drive1");
const network = new Light("networklight");

syncLights = function () {
    if (model.isAtom) {
        cassette.update(processor.atomppia.motorOn);
    } else {
        caps.update(processor.sysvia.capsLockLight);
        shift.update(processor.sysvia.shiftLockLight);
        drive0.update(processor.fdc.motorOn[0]);
        drive1.update(processor.fdc.motorOn[1]);
        cassette.update(processor.acia.motorOn);
        if (processor.econet) {
            network.update(processor.econet.activityLight());
        }
    }
};

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

    async function insertBasic(getBasicPromise, needsRun) {
        const prog = await getBasicPromise;
        const t = await tokeniser.create();
        const tokenised = await t.tokenise(prog);

        const idleAddr = processor.model.isMaster ? 0xe7e6 : 0xe581;
        const hook = processor.debugInstruction.add(function (addr) {
            if (addr !== idleAddr) return;
            const page = processor.readmem(0x18) << 8;
            for (let i = 0; i < tokenised.length; ++i) {
                processor.writemem(page + i, tokenised.charCodeAt(i));
            }
            // Set VARTOP (0x12/3) and TOP(0x02/3)
            const end = page + tokenised.length;
            const endLow = end & 0xff;
            const endHigh = (end >>> 8) & 0xff;
            processor.writemem(0x02, endLow);
            processor.writemem(0x03, endHigh);
            processor.writemem(0x12, endLow);
            processor.writemem(0x13, endHigh);
            hook.remove();
            if (needsRun) {
                autoRunBasic();
            }
        });
    }

    if (parsedQuery.loadBasic) {
        const needsRun = needsAutoboot === "run";
        needsAutoboot = "";

        await startImageLoad(`BASIC program ${parsedQuery.loadBasic}`, () =>
            insertBasic(
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
            insertBasic(Promise.resolve(parsedQuery.embedBasic), true),
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
                autoboot(discImage);
                break;
            case "type":
                autoBootType(autoType);
                break;
            case "chain":
                autoChainTape();
                break;
            case "run":
                autoRunTape();
                break;
            default:
                autobootTicks.show(false);
                break;
        }

        if (parsedQuery.patch) {
            dbgr.setPatch(parsedQuery.patch);
        }

        // Restore pending state from a cross-model load (sessionStorage)
        const pendingState = sessionStorage.getItem("jsbeeb-pending-state");
        if (pendingState) {
            sessionStorage.removeItem("jsbeeb-pending-state");
            try {
                const snapshot = snapshotFromJSON(pendingState);
                // Order matters: reload disc media first so the base disc is in the
                // drive before restoreSnapshot applies dirty track overlays on top.
                await reloadSnapshotMedia(snapshot.media);
                restoreSnapshot(processor, model, snapshot);
                processor.execute(40000);
            } catch (e) {
                modals.showError("restoring saved state", e);
            }
        }

        go();
    } catch (error) {
        console.error("Error initialising emulator:", error);
        modals.showError("initialising", error);
    }
})();

function benchmarkCpu(numCycles) {
    numCycles = numCycles || 10 * 1000 * 1000;
    const oldFS = frameSkip;
    frameSkip = 1000000;
    const startTime = performance.now();
    processor.execute(numCycles);
    const endTime = performance.now();
    frameSkip = oldFS;
    const msTaken = endTime - startTime;
    const virtualMhz = numCycles / msTaken / 1000;
    console.log("Took " + msTaken + "ms to execute " + numCycles + " cycles");
    console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
}

function benchmarkVideo(numCycles) {
    numCycles = numCycles || 10 * 1000 * 1000;
    const oldFS = frameSkip;
    frameSkip = 1000000;
    const startTime = performance.now();
    video.polltime(numCycles);
    const endTime = performance.now();
    frameSkip = oldFS;
    const msTaken = endTime - startTime;
    const virtualMhz = numCycles / msTaken / 1000;
    console.log("Took " + msTaken + "ms to execute " + numCycles + " video cycles");
    console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
}

function profileCpu(arg) {
    console.profile("CPU");
    benchmarkCpu(arg);
    console.profileEnd();
}

function profileVideo(arg) {
    console.profile("Video");
    benchmarkVideo(arg);
    console.profileEnd();
}

let last = 0;
let lastEnd = 0;

function VirtualSpeedUpdater() {
    this.cycles = 0;
    this.time = 0;
    this.v = document.querySelector(".virtualMHz");
    this.header = document.getElementById("virtual-mhz-header");
    this.speedy = false;

    this.update = function (cycles, time, speedy) {
        this.cycles += cycles;
        this.time += time;
        this.speedy = speedy;
    };

    this.display = function () {
        // MRG would be nice to graph instantaneous speed to get some idea where the time goes.
        if (this.cycles) {
            const thisMHz = this.cycles / this.time / 1000;
            this.v.textContent = thisMHz.toFixed(1);
            if (this.cycles >= 10 * cpuSpeed) {
                this.cycles = this.time = 0;
            }
            this.header.style.color = this.speedy ? "red" : "white";
        }
        setTimeout(this.display.bind(this), 3333);
    };

    this.display();
}

const virtualSpeedUpdater = new VirtualSpeedUpdater();

const rewindBuffer = new RewindBuffer(30);
let rewindCycleCounter = 0;
const RewindCaptureInterval = 50; // emulated frames, ~1 second
const RewindCaptureCycles = (RewindCaptureInterval * clocksPerSecond) / 50;

// Under ?audioDebug, one console line per second in which the emulator sat
// idle between ticks or a tick ran long, or the audio queue underran or
// dropped, so a click can be matched to a cause. The sound chip posts samples
// throughout execute(), so only the idle time starves the audio queue.
const AudioDebugLogIntervalMs = 1000;
const AudioDebugSlowTickMs = 30;
const audioDebugLog = { start: 0, ticks: 0, cycles: 0, maxIdle: 0, maxExecute: 0, maxPaint: 0, maxSnapshot: 0 };
const AudioDebugSlowPresentMs = 30;

function logAudioDebugTick(now, cycles, idleMs, executeMs, paintMs, snapshotMs) {
    const log = audioDebugLog;
    if (log.start === 0) log.start = now;
    log.ticks++;
    log.cycles += cycles;
    log.maxIdle = Math.max(log.maxIdle, idleMs);
    log.maxExecute = Math.max(log.maxExecute, executeMs);
    log.maxPaint = Math.max(log.maxPaint, paintMs);
    log.maxSnapshot = Math.max(log.maxSnapshot, snapshotMs);
    if (now - log.start < AudioDebugLogIntervalMs) return;
    const audio = audioHandler.takeEventCounts();
    const present = presentMsMax;
    presentMsMax = 0;
    const leadMin = Number.isFinite(audio.leadMinMs) ? `${audio.leadMinMs.toFixed(1)}ms` : "(no stats)";
    if (
        log.maxIdle > AudioDebugSlowTickMs ||
        log.maxExecute > AudioDebugSlowTickMs ||
        present > AudioDebugSlowPresentMs ||
        audio.stall ||
        audio.skip
    ) {
        console.log(
            `${(now / 1000).toFixed(0)}s: ${log.ticks} ticks emulating ${((1000 * log.cycles) / clocksPerSecond).toFixed(0)}ms, ` +
                `idle max ${log.maxIdle.toFixed(0)}ms, ` +
                `execute max ${log.maxExecute.toFixed(0)}ms (paint ${log.maxPaint.toFixed(1)}ms), ` +
                `present max ${present.toFixed(0)}ms, snapshot ${log.maxSnapshot.toFixed(1)}ms; ` +
                `audio lead min ${leadMin}, stalls ${audio.stall}, skipped ${audio.skip.toFixed(0)}ms`,
        );
    }
    log.start = now;
    log.ticks = log.cycles = log.maxIdle = log.maxExecute = log.maxPaint = log.maxSnapshot = 0;
}

rewindUI = new RewindUI({
    rewindBuffer,
    processor,
    video,
    captureInterval: RewindCaptureInterval,
    stop,
    go,
    isRunning: () => running,
});
rewindUI.updateButtonState();

if (processor.fdc) new DiscVisualiser({ fdc: processor.fdc });
else document.getElementById("disc-visualiser-open").classList.add("disabled");

// A timer, not requestAnimationFrame: a display presentation stall withholds
// animation frames, and with them the sound chip's samples (issue #885).
const TickMs = 10;
let tickToken = null;

// A user-blocking task runs ahead of rendering and ordinary timers, so a stuck
// compositor does not hold the tick off too.
function scheduleTick(delayMs) {
    const token = (tickToken = {});
    const fire = () => {
        if (tickToken === token) tick();
    };
    if (window.scheduler?.postTask) window.scheduler.postTask(fire, { delay: delayMs, priority: "user-blocking" });
    else window.setTimeout(fire, delayMs);
}

function tick() {
    if (!running) {
        last = 0;
        return;
    }
    const now = performance.now();

    const motorOn = processor.acia.motorOn;
    const speedy = fastAsPossible || (fastTape && motorOn);

    // In speedy mode, we still run all the state machines accurately
    // but we paint less often because painting is the most expensive
    // part of jsbeeb at this time.
    // We need need to paint per odd number of frames so that interlace
    // modes, i.e. MODE 7, still look ok.
    video.frameSkipCount = speedy ? 9 : 0;

    scheduleTick(speedy ? 0 : TickMs);

    gamepad.update(processor.sysvia);
    syncLights();
    if (last !== 0) {
        let cycles;
        if (!speedy) {
            const sinceLast = Math.max(0, now - last);
            cycles = (sinceLast * clocksPerSecond) / 1000;
            cycles = Math.min(cycles, MaxCyclesPerTick);
        } else {
            cycles = clocksPerSecond / 50;
        }
        cycles |= 0;
        try {
            if (!processor.execute(cycles)) {
                stop(true);
            }
            audioHandler.flushChipEvents();
            const end = performance.now();
            virtualSpeedUpdater.update(cycles, end - now, speedy);
            let snapshotMs = 0;
            rewindCycleCounter += cycles;
            if (rewindCycleCounter >= RewindCaptureCycles) {
                rewindCycleCounter -= RewindCaptureCycles;
                rewindBuffer.push(processor.snapshotState());
                rewindUI.updateButtonState();
                snapshotMs = performance.now() - end;
            }
            if (audioStatsNode)
                logAudioDebugTick(now, cycles, speedy ? 0 : now - lastEnd, end - now, paintMsThisTick, snapshotMs);
            paintMsThisTick = 0;
        } catch (e) {
            running = false;
            utils.noteEvent("exception", "thrown", e.stack);
            dbgr.debug(processor.pc);
            throw e;
        }
        if (keyboard.postFrameShouldPause()) {
            stop(false);
        }
    }
    last = Math.max(last, now);
    lastEnd = performance.now();
}

function run() {
    scheduleTick(0);
}

// A change of audio buffer depth is taken by the picture, not the sound:
// gaining lead emulates ahead at once; losing it moves `last` forward so the
// ticks emulate nothing until the queue has drained by that much.
let emulationLeadMs = 0;

function setEmulationLead(leadMs) {
    if (!running) return;
    const aheadMs = leadMs - emulationLeadMs;
    emulationLeadMs = leadMs;
    if (aheadMs > 0) {
        if (!processor.execute((aheadMs * clocksPerSecond) / 1000)) stop(true);
        audioHandler.flushChipEvents();
    } else {
        last -= aheadMs;
    }
}

let wasPreviouslyRunning = false;

function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
        wasPreviouslyRunning = running;
        const keepRunningWhenHidden = processor.acia.motorOn || processor.fdc.motorOn[0] || processor.fdc.motorOn[1];
        if (running && !keepRunningWhenHidden) {
            stop(false);
        }
    } else {
        if (wasPreviouslyRunning) {
            go();
        }
    }
}

document.addEventListener("visibilitychange", handleVisibilityChange, false);

function updateDebugButtons() {
    debugPlay.disabled = running;
    debugPause.disabled = !running;
}

function go() {
    audioHandler.unmute();
    running = true;
    keyboard.setRunning(true);
    updateDebugButtons();
    run();
}

function stop(debug) {
    running = false;
    keyboard.setRunning(false);
    processor.stop();
    if (debug) dbgr.debug(processor.pc);
    audioHandler.mute();
    updateDebugButtons();
}

/** Steps the drawing buffer grows in, as a multiple of the base canvas size. */
const CanvasScaleStep = 0.25;

(function () {
    const resizeCubMonitor = document.getElementById("cub-monitor");
    const resizeCubMonitorPic = document.getElementById("cub-monitor-pic");
    const borderReservedSize = parsedQuery.embed !== undefined ? 0 : 100;
    const bottomReservedSize = parsedQuery.embed !== undefined ? 0 : 68;

    function resizeTv() {
        // Get current display config (may change when display mode switches)
        const displayConfig = displayModeFilter.getDisplayConfig();

        const imageOrigHeight = displayConfig.imageHeight;
        const imageOrigWidth = displayConfig.imageWidth;
        const canvasOrigLeft = displayConfig.canvasLeft;
        const canvasOrigTop = displayConfig.canvasTop;
        const visibleWidth = displayConfig.visibleWidth;
        const visibleHeight = displayConfig.visibleHeight;

        const canvasNativeWidth = screenCanvas.getAttribute("width");
        const canvasNativeHeight = screenCanvas.getAttribute("height");
        const desiredAspectRatio = imageOrigWidth / imageOrigHeight;
        const minWidth = imageOrigWidth / 4;
        const minHeight = imageOrigHeight / 4;

        let navbarHeight = document.getElementById("header-bar")?.offsetHeight || 0;
        let width = Math.max(minWidth, window.innerWidth - borderReservedSize * 2);
        let height = Math.max(minHeight, window.innerHeight - navbarHeight - bottomReservedSize);
        if (width / height <= desiredAspectRatio) {
            height = width / desiredAspectRatio;
        } else {
            width = height * desiredAspectRatio;
        }

        const containerScale = width / imageOrigWidth;
        const scaledVisibleWidth = visibleWidth * containerScale;
        const scaledVisibleHeight = visibleHeight * containerScale;

        const canvasAspect = canvasNativeWidth / canvasNativeHeight;
        const visibleAspect = scaledVisibleWidth / scaledVisibleHeight;

        let finalCanvasWidth, finalCanvasHeight;
        if (canvasAspect > visibleAspect) {
            finalCanvasWidth = scaledVisibleWidth;
            finalCanvasHeight = scaledVisibleWidth / canvasAspect;
        } else {
            finalCanvasHeight = scaledVisibleHeight;
            finalCanvasWidth = scaledVisibleHeight * canvasAspect;
        }

        resizeCubMonitor.style.height = height + "px";
        resizeCubMonitor.style.width = width + "px";
        resizeCubMonitorPic.style.height = height + "px";
        resizeCubMonitorPic.style.width = width + "px";
        // A mode that reconstructs detail wants to draw at the size it will be
        // seen at, up to the limit it asks for. Drawing more than the display
        // can show costs fragments and buys nothing, and for an expensive
        // shader that is the difference between comfortable and not.
        if (displayConfig.maxCanvasScale) {
            const wanted = (finalCanvasWidth * (window.devicePixelRatio || 1)) / displayConfig.canvasWidth;
            // Quantised, because resize fires continuously while a window is
            // dragged and every distinct value reallocates the drawing buffer.
            const quantised = Math.round(wanted / CanvasScaleStep) * CanvasScaleStep;
            const scale = Math.min(displayConfig.maxCanvasScale, Math.max(1, quantised));
            const backingWidth = Math.round(displayConfig.canvasWidth * scale);
            if (screenCanvas.width !== backingWidth) {
                screenCanvas.width = backingWidth;
                screenCanvas.height = Math.round(displayConfig.canvasHeight * scale);
                // Resizing threw the drawing buffer away.
                video.paint();
            }
        }

        screenCanvas.style.width = finalCanvasWidth + "px";
        screenCanvas.style.height = finalCanvasHeight + "px";
        screenCanvas.style.left = canvasOrigLeft * containerScale + "px";
        screenCanvas.style.top = canvasOrigTop * containerScale + "px";
    }

    window.addEventListener("resize", resizeTv);
    window.setTimeout(resizeTv, 1);
    window.setTimeout(resizeTv, 500);
})();

if (Object.hasOwn(parsedQuery, "about")) modals.show("info");
if (Object.hasOwn(parsedQuery, "pp-tos")) modals.show("pp-tos");

// Handy shortcuts. bench/profile stuff is delayed so that they can be
// safely run from the JS console in firefox.
window.benchmarkCpu = utils.debounce(benchmarkCpu, 1);
window.profileCpu = utils.debounce(profileCpu, 1);
window.benchmarkVideo = utils.debounce(benchmarkVideo, 1);
window.profileVideo = utils.debounce(profileVideo, 1);
window.go = go;
window.stop = stop;
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
    loadStateFile: loadStateFromFile,
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
