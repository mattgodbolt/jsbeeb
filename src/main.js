import * as bootstrap from "bootstrap";
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
import { StairwayToHell } from "./sth.js";
import { BbcDiscArchive, describe as describeHfe } from "./bbcdiscs.js";
import { GamePad } from "./gamepads.js";
import * as disc from "./fdc.js";
import { loadTapeFromData } from "./tapes.js";
import { GoogleDriveLoader } from "./google-drive.js";
import * as tokeniser from "./basic-tokenise.js";
import * as canvasLib from "./canvas.js";
import { Config } from "./config.js";
import { DefaultModel, findModel, tubeModelFor } from "./models.js";
import { initialise as electron } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { Econet } from "./econet.js";
import { DiscLayout, toSsdOrDsd } from "./disc.js";
import { toHfe } from "./disc-hfe.js";
import { Keyboard } from "./keyboard.js";
import { GamepadSource } from "./gamepad-source.js";
import { toast } from "./web/toast.js";
import { MicrophoneInput } from "./microphone-input.js";
import { SpeechOutput } from "./speech-output.js";
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
import { downloadBlob } from "./dom-utils.js";
import {
    buildUrlFromParams,
    DriveTracks,
    guessModelFromHostname,
    ParamTypes,
    parseMediaParams,
    parseQueryString,
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
let discSth;
let tapeSth;
let hfeArchive;
let running;
let model;

// Route tape to the correct interface (ACIA for BBC, PPIA for Atom)
function setProcessorTape(tape) {
    if (model.isAtom) {
        processor.atomppia.setTape(tape);
    } else {
        processor.acia.setTape(tape);
    }
}

// Convert text to machine-appropriate key sequences (BBC or Atom)
function stringToMachineKeys(text) {
    return model.isAtom ? utils_atom.stringToATOMKeys(text) : utils.stringToBBCKeys(text);
}

const gamepad = new GamePad();
const availableImages = [
    {
        name: "Elite",
        desc: "An 8-bit classic. Hit F10 to launch from the space station, then use <, >, S, X and A to fly around.",
        file: "elite.ssd",
    },
    {
        name: "Welcome",
        desc: "The disc supplied with BBC Disc systems to demonstrate some of the features of the system.",
        file: "Welcome.ssd",
    },
    {
        name: "Music 5000",
        desc: "The Music 5000 system disk and demo songs.",
        file: "5000mstr36008.ssd",
    },
];
let discImage = availableImages[0].file;
const extraRoms = [];

// Build the query string from the URL
const queryString = document.location.search.substring(1) + "&" + window.location.hash.substring(1);
let secondDiscImage = null;

// Define parameter types
const paramTypes = {
    // Array parameters
    rom: ParamTypes.ARRAY,

    // Boolean parameters
    embed: ParamTypes.BOOL,
    fasttape: ParamTypes.BOOL,
    noseek: ParamTypes.BOOL,
    debug: ParamTypes.BOOL,
    verbose: ParamTypes.BOOL,
    autoboot: ParamTypes.BOOL,
    autochain: ParamTypes.BOOL,
    autorun: ParamTypes.BOOL,
    hasMusic5000: ParamTypes.BOOL,
    hasTeletextAdaptor: ParamTypes.BOOL,
    hasEconet: ParamTypes.BOOL,
    glEnabled: ParamTypes.BOOL,
    fakeVideo: ParamTypes.BOOL,
    logFdcCommands: ParamTypes.BOOL,
    logFdcStateChanges: ParamTypes.BOOL,
    coProcessor: ParamTypes.BOOL,
    mouseJoystickEnabled: ParamTypes.BOOL,
    speechOutput: ParamTypes.BOOL,
    audioDebug: ParamTypes.BOOL,

    // Numeric parameters
    speed: ParamTypes.INT,
    stationId: ParamTypes.INT,
    frameSkip: ParamTypes.INT,
    audiofilterfreq: ParamTypes.FLOAT,
    audiofilterq: ParamTypes.FLOAT,
    cpuMultiplier: ParamTypes.FLOAT,
    tubeCpuMultiplier: ParamTypes.FLOAT,
    microphoneChannel: ParamTypes.INT,

    // String parameters (these are the default but listed for clarity)
    model: ParamTypes.STRING,
    disc: ParamTypes.STRING,
    disc1: ParamTypes.STRING,
    disc2: ParamTypes.STRING,
    tape: ParamTypes.STRING,
    mmc: ParamTypes.STRING,
    keyLayout: ParamTypes.STRING,
    autotype: ParamTypes.STRING,
    displayMode: ParamTypes.STRING,
    drive0Tracks: ParamTypes.STRING,
    drive1Tracks: ParamTypes.STRING,
};

// Parse the query string with parameter types
let parsedQuery = parseQueryString(queryString, paramTypes);
let { needsAutoboot, autoType } = processAutobootParams(parsedQuery);
let keyLayout = window.localStorage.keyLayout || "physical";

const BBC = utils.BBC;
const keyCodes = utils.keyCodes;
const cpuMultiplier = parsedQuery.cpuMultiplier ?? 1;
let fastAsPossible = false;
let fastTape = false;
let noSeek;
let audioFilterFreq = 7000;
let audioFilterQ = 5;
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

if (parsedQuery.audiofilterfreq !== undefined) audioFilterFreq = parsedQuery.audiofilterfreq;
if (parsedQuery.audiofilterq !== undefined) audioFilterQ = parsedQuery.audiofilterq;
if (parsedQuery.stationId !== undefined) stationId = parsedQuery.stationId;
if (parsedQuery.frameSkip !== undefined) frameSkip = parsedQuery.frameSkip;

const printerPort = {
    outputStrobe: function (level, output) {
        if (!printerTextArea) return;
        if (!output || level) return;

        const uservia = processor.uservia;
        // Ack the character by pulsing CA1 low.
        uservia.setca1(false);
        uservia.setca1(true);
        const newChar = String.fromCharCode(uservia.ora);
        printerTextArea.value += newChar;
    },
};

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
speechOutput.enabled = !!parsedQuery.speechOutput;

const config = new Config(
    function onChange(changed) {
        if (changed.displayMode) {
            // swapCanvas settles displayModeFilter on whatever was really
            // built, so take the picture from that rather than the request.
            swapCanvas(getFilterForMode(changed.displayMode));
            setCrtPic(displayModeFilter);
            // Trigger window resize to recalculate layout with new dimensions
            window.dispatchEvent(new Event("resize"));
        }
    },
    function onClose(changed) {
        parsedQuery = Object.assign(parsedQuery, changed);
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
        if (changed.speechOutput !== undefined) {
            speechOutput.enabled = !!changed.speechOutput;
        }
        if (changed.tubeCpuMultiplier !== undefined) {
            emulationConfig.tubeCpuMultiplier = changed.tubeCpuMultiplier;
            config.setTubeCpuMultiplier(changed.tubeCpuMultiplier);
            if (processor.hasTube) {
                processor.tube.cpuMultiplier = changed.tubeCpuMultiplier;
            }
        }
        updateUrl();
    },
    function onRestartRequired() {
        areYouSure(
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
let displayMode = parsedQuery.displayMode || "rgb";
config.setDisplayMode(displayMode);

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
    printerPort,
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
const MaxCyclesPerFrame = clocksPerSecond / 10;

let tryGl = true;
if (parsedQuery.glEnabled !== undefined) {
    tryGl = parsedQuery.glEnabled === "true";
}
const screenCanvas = document.getElementById("screen");

const errorDialog = document.getElementById("error-dialog");
const errorDialogModal = new bootstrap.Modal(errorDialog);

async function compressBlob(blob) {
    const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).blob();
}

async function decompressBlob(blob) {
    const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).blob();
}

function showError(context, error) {
    errorDialog.querySelector(".context").textContent = context;
    errorDialog.querySelector(".error").textContent = error;
    errorDialogModal.show();
}

const errorText = (error) => error?.message ?? `${error}`;

function showNotice(event) {
    const { message, title, quietKey } = event.detail;
    toast(message, { title, quietKey });
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

/** @returns {string} the DiscLayout to load an image for this drive with */
function layoutForDrive(driveIndex) {
    return driveTracks[driveIndex] === DriveTracks.eighty ? DiscLayout.contiguous : DiscLayout.auto;
}

/** @returns {Number|undefined} the tracksPerStep the user fixed this drive at, if they fixed one */
function tracksPerStepForDrive(driveIndex) {
    if (driveTracks[driveIndex] === DriveTracks.auto) return undefined;
    return driveTracks[driveIndex] === DriveTracks.forty ? 2 : 1;
}

function putDiscIn(driveIndex, loadedDisc) {
    const drive = processor.fdc.drives[driveIndex];
    const fixed = tracksPerStepForDrive(driveIndex);
    const was = drive.tracksPerStep;
    processor.fdc.loadDisc(driveIndex, loadedDisc, fixed);
    showDriveTracks(driveIndex);
    // A switch the user fixed does not move, so anything it does is not news.
    if (fixed === undefined && drive.tracksPerStep !== was) noteDriveTracks(driveIndex, loadedDisc.name);
}

const tracksPerStepFor = (tracks) => (tracks === "40" ? 2 : 1);

function showDriveTracks(driveIndex) {
    const drive = processor.fdc?.drives[driveIndex];
    if (!drive) return;
    for (const button of driveTracksButtons(driveIndex))
        button.classList.toggle("active", tracksPerStepFor(button.dataset.tracks) === drive.tracksPerStep);
}

function driveTracksButtons(driveIndex) {
    return document.querySelectorAll(`.drive-tracks[data-drive="${driveIndex}"] [data-tracks]`);
}

function noteDriveTracks(driveIndex, discName) {
    const tracks = processor.fdc.drives[driveIndex].tracksPerStep === 2 ? "40" : "80";
    toast(`Drive ${driveIndex} switched to ${tracks} track for ${discName}.`, {
        title: "Disc drive",
        quietKey: "quietDriveTracks",
    });
}

function createCanvasForFilter(filterClass) {
    // Not `config`: that is the emulator's live configuration object, declared
    // at module scope and used throughout this file.
    const displayConfig = filterClass.getDisplayConfig();
    // Each mode says how many pixels it wants to draw into. Set this before
    // creating the context, which fixes its initial viewport.
    screenCanvas.width = displayConfig.canvasWidth;
    screenCanvas.height = displayConfig.canvasHeight;

    const newCanvas = tryGl ? canvasLib.bestCanvas(screenCanvas, filterClass) : new canvasLib.Canvas(screenCanvas);

    // Test which filter was actually built, not merely whether we got WebGL: a
    // filter can decline a context that works perfectly well for other modes,
    // in which case bestCanvas quietly gives us an unfiltered GL canvas.
    if (newCanvas.filterClass !== filterClass) {
        const reason = newCanvas.fallbackReason ? ` (${newCanvas.fallbackReason})` : "";
        toast(`${displayConfig.name} is not available on this device, so the standard display is in use${reason}.`, {
            title: "Display",
            quietKey: "quietDisplayFallback",
        });
    }

    return newCanvas;
}

let displayModeFilter = canvasLib.getFilterForMode(parsedQuery.displayMode || "rgb");
function swapCanvas(newFilterClass) {
    const oldCanvas = canvas;
    const newCanvas = createCanvasForFilter(newFilterClass);
    // Carry the picture over; the buffers differ in height, so copy what fits.
    newCanvas.fb32.set(oldCanvas.fb32.subarray(0, newCanvas.fb32.length));
    // Only once the replacement exists, so a failure to build it leaves the
    // display we already had. The two share a GL context but no GL objects.
    oldCanvas.dispose();
    video.fb32 = newCanvas.fb32;
    video.paint_ext = function paint(minx, miny, maxx, maxy) {
        frames++;
        if (frames < frameSkip) return;
        frames = 0;
        newCanvas.paint(minx, miny, maxx, maxy, { frameCount: this.frameCount, lineGrid: this.lineGrid });
    };
    canvas = newCanvas;
    // Follow the filter we ended up with, not the one we asked for: everything
    // downstream — the monitor picture, the canvas geometry, how large a
    // drawing buffer to ask for — comes from its display config.
    displayModeFilter = newCanvas.filterClass;
    // Nothing else will redraw: the mode is changed from a modal, which stops
    // the emulator.
    video.paint();
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 1);
}

let canvas = createCanvasForFilter(displayModeFilter);
displayModeFilter = canvas.filterClass;

video = new Video(
    model.isMaster,
    canvas.fb32,
    function paint(minx, miny, maxx, maxy) {
        frames++;
        if (frames < frameSkip) return;
        frames = 0;
        canvas.paint(minx, miny, maxx, maxy, { frameCount: this.frameCount, lineGrid: this.lineGrid });
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
    audioFilterFreq,
    audioFilterQ,
    noSeek,
    cpuSpeed,
    isAtom: model.isAtom,
});
// Firefox will report that audio is suspended even when it will
// start playing without user interaction, so we need to delay a
// little to get a reliable indication.
window.setTimeout(() => audioHandler.checkStatus(), 1000);

for (const el of document.querySelectorAll(".initially-hidden")) el.classList.remove("initially-hidden");

const $discsModal = new bootstrap.Modal(document.getElementById("discs"));
const $fsModal = new bootstrap.Modal(document.getElementById("econetfs"));

/**
 * Helper function to read a file as binary string
 * @param {File} file - The file to read
 * @returns {Promise<string>} - Promise that resolves with the binary string content of the file, or rejects on error
 */
function readFileAsBinaryString(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            resolve(e.target.result);
        };
        reader.onerror = (e) => {
            console.error(`Error reading file ${file.name}:`, e);
            reject(new Error(`Failed to read file ${file.name}`));
        };
        reader.readAsBinaryString(file);
    });
}

function replaceOrAddExtension(name, newExt) {
    const lastDot = name.lastIndexOf(".");
    if (lastDot === -1) {
        return name + newExt;
    }
    return name.substring(0, lastDot) + newExt;
}

/**
 * Helper function to download drive data in the specified format
 * @param {Uint8Array} data - The binary data to download
 * @param {string} name - The file name
 * @param {string} extension - The file extension to use
 */
function downloadDriveData(data, name, extension) {
    const blob = new Blob([data], { type: "application/octet-stream" });
    downloadBlob(blob, replaceOrAddExtension(name, extension));
}

async function loadHTMLFile(file) {
    const imageData = utils.stringToUint8Array(await readFileAsBinaryString(file));
    const loadedDisc = disc.discFor(processor.fdc, file.name, imageData, undefined, layoutForDrive(0));
    // Local file: retain the image bytes for embedding in save-to-file snapshots.
    loadedDisc.setOriginalImage(imageData);
    putDiscIn(0, loadedDisc);
    delete parsedQuery.disc;
    delete parsedQuery.disc1;
    updateUrl();
    $discsModal.hide();
}

async function loadSCSIFile(file) {
    const binaryData = await readFileAsBinaryString(file);
    processor.filestore.scsi = utils.stringToUint8Array(binaryData);

    processor.filestore.PC = 0x400;
    processor.filestore.SP = 0xff;
    processor.filestore.A = 1;
    processor.filestore.emulationSpeed = 0;

    // Reset any open receive blocks
    processor.econet.receiveBlocks = [];
    processor.econet.nextReceiveBlockNumber = 1;

    $fsModal.hide();
}

const pastetext = document.getElementById("paste-text");
pastetext.closest("form").addEventListener("submit", (event) => event.preventDefault());
pastetext.addEventListener("paste", function (event) {
    const text = event.clipboardData.getData("text/plain");
    sendRawKeyboard(stringToMachineKeys(text), true);
});
pastetext.addEventListener("dragover", function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
});
pastetext.addEventListener("drop", async function (event) {
    utils.noteEvent("local", "drop");
    const file = event.dataTransfer.files[0];
    const arrayBuffer = await file.arrayBuffer();
    if (isSnapshotFile(file.name, arrayBuffer)) {
        await loadStateFromFile(file, arrayBuffer);
    } else if (file.name.toLowerCase().endsWith(".uef")) {
        // Regular UEF tape image (not a BeebEm save state)
        setProcessorTape(await loadTapeFromData(file.name, new Uint8Array(arrayBuffer), model));
    } else {
        await loadHTMLFile(file);
    }
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
});

document.getElementById("fs").addEventListener("click", function (event) {
    screenCanvas.requestFullscreen();
    event.preventDefault();
});

let keyboard; // This will be initialised after the processor is created

const debugPause = document.getElementById("debug-pause");
const debugPlay = document.getElementById("debug-play");
debugPause.addEventListener("click", () => stop(true));
debugPlay.addEventListener("click", () => {
    dbgr.hide();
    go();
});

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

    processor.uservia.setca1(true);
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

processor.teletextAdaptor?.addEventListener("notice", showNotice);

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
        updateUrl();
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

function setDisc1Image(name) {
    delete parsedQuery.disc;
    parsedQuery.disc1 = name;
    updateUrl();
    config.dispatchEvent(new CustomEvent("media-changed", { detail: { disc1: name } }));
}

function setDisc2Image(name) {
    parsedQuery.disc2 = name;
    updateUrl();
    config.dispatchEvent(new CustomEvent("media-changed", { detail: { disc2: name } }));
}

function setTapeImage(name) {
    parsedQuery.tape = name;
    updateUrl();
    config.dispatchEvent(new CustomEvent("media-changed", { detail: { tape: name } }));
}

function clearArchiveList(listId) {
    for (const el of document.querySelectorAll(`#${listId} li:not(.template)`)) el.remove();
}

function showArchiveMessage(modalId, listId, message) {
    const loading = document.querySelector(`#${modalId} .loading`);
    loading.textContent = message;
    loading.style.display = "";
    clearArchiveList(listId);
}

function filterArchiveList(listId, filter) {
    filter = filter.toLowerCase();
    for (const el of document.querySelectorAll(`#${listId} li:not(.template)`)) {
        el.style.display = el.textContent.toLowerCase().includes(filter) ? "" : "none";
    }
}

function sthStartLoad() {
    showArchiveMessage("sth", "sth-list", "Loading catalog from STH archive");
}

async function discSthClick(item) {
    utils.noteEvent("sth", "click", item);
    setDisc1Image("sth:" + item);
    const needsAutoboot = parsedQuery.autoboot !== undefined;
    if (needsAutoboot) {
        processor.reset(true);
    }

    popupLoading("Loading " + item);
    try {
        const loaded = await loadDiscImage(parsedQuery.disc1, layoutForDrive(0));
        putDiscIn(0, loaded);
        loadingFinished();

        if (needsAutoboot) {
            autoboot(item);
        }
    } catch (err) {
        console.error("Error loading disc image:", err);
        loadingFinished(`Unable to load ${item} from the STH archive: ${errorText(err)}`);
    }
}

async function tapeSthClick(item) {
    utils.noteEvent("sth", "clickTape", item);
    setTapeImage("sth:" + item);

    popupLoading("Loading " + item);
    try {
        const tape = await loadTapeImage(parsedQuery.tape);
        setProcessorTape(tape);
        loadingFinished();
    } catch (err) {
        console.error("Error loading tape image:", err);
        loadingFinished(`Unable to load ${item} from the STH archive: ${errorText(err)}`);
    }
}

const $sthModal = new bootstrap.Modal(document.getElementById("sth"));
document.getElementById("sth").addEventListener("shown.bs.modal", () => {
    document.getElementById("sth-filter").focus();
});

function makeOnCat(onClick) {
    return function (cat) {
        clearArchiveList("sth-list");
        const sthList = document.getElementById("sth-list");
        document.querySelector("#sth .loading").style.display = "none";
        const template = sthList.querySelector(".template");

        function doSome(all) {
            const MaxAtATime = 100;
            const Delay = 30;
            const batch = all.slice(0, MaxAtATime);
            const remaining = all.slice(MaxAtATime);
            const filter = document.getElementById("sth-filter").value;
            for (const name of batch) {
                const row = template.cloneNode(true);
                row.classList.remove("template");
                sthList.appendChild(row);
                row.querySelector(".name").textContent = name;
                row.addEventListener("click", function () {
                    onClick(name);
                    $sthModal.hide();
                });
                row.style.display = name.toLowerCase().indexOf(filter) >= 0 ? "" : "none";
            }
            if (all.length) setTimeout(() => doSome(remaining), Delay);
        }

        doSome(cat);
    };
}

function sthOnError() {
    showArchiveMessage("sth", "sth-list", "There was an error accessing the STH archive");
}

discSth = new StairwayToHell(sthStartLoad, makeOnCat(discSthClick), sthOnError, false);
tapeSth = new StairwayToHell(sthStartLoad, makeOnCat(tapeSthClick), sthOnError, true);
hfeArchive = new BbcDiscArchive(hfeStartLoad, hfeOnCat, hfeOnError);

// Every archive picker offers the same autoboot choice, and it is one setting,
// so ticking it in either has to show in both.
const autobootChecks = document.querySelectorAll("#sth .autoboot, #hfe .autoboot");
function showAutoboot(checked) {
    for (const check of autobootChecks) check.checked = checked;
}
for (const check of autobootChecks) {
    check.addEventListener("click", function () {
        showAutoboot(check.checked);
        if (check.checked) {
            parsedQuery.autoboot = "";
        } else {
            delete parsedQuery.autoboot;
        }
        updateUrl();
    });
}

document.addEventListener("click", function (e) {
    const target = e.target.closest("a.sth");
    if (!target) return;
    const type = target.dataset.id;
    if (type === "discs") {
        discSth.populate();
    } else if (type === "tapes") {
        tapeSth.populate();
    } else {
        console.log("unknown id", type);
    }
});

function setSthFilter(filter) {
    filterArchiveList("sth-list", filter);
}

const sthFilter = document.getElementById("sth-filter");
sthFilter.addEventListener("change", () => setSthFilter(sthFilter.value));
sthFilter.addEventListener("keyup", () => setSthFilter(sthFilter.value));

// Rendering is spread over several turns of the event loop, so a list that has
// been emptied may still have a chain of appends heading for it. Anything that
// clears the list takes a new ticket; a chain whose ticket is stale gives up.
let hfeRender = 0;

function hfeStartLoad() {
    hfeRender++;
    showArchiveMessage("hfe", "hfe-list", "Loading catalogue from HFE archive");
}

function hfeOnError() {
    hfeRender++;
    showArchiveMessage("hfe", "hfe-list", "There was an error accessing the HFE archive");
}

async function hfeClick(file) {
    utils.noteEvent("hfe", "click", file.path);
    setDisc1Image("hfe:" + file.path);
    const needsAutoboot = parsedQuery.autoboot !== undefined;
    if (needsAutoboot) processor.reset(true);

    const name = describeHfe(file).title;
    popupLoading("Loading " + name);
    try {
        const disc = await loadDiscImage(parsedQuery.disc1);
        processor.fdc.loadDisc(0, disc);
        loadingFinished();
        if (needsAutoboot) autoboot(name);
    } catch (err) {
        console.error("Error loading disc image:", err);
        loadingFinished(err);
    }
}

function hfeOnCat(catalogue) {
    const ticket = ++hfeRender;
    clearArchiveList("hfe-list");
    const list = document.getElementById("hfe-list");
    document.querySelector("#hfe .loading").style.display = "none";
    const template = list.querySelector(".template");

    const addSome = (remaining) => {
        if (ticket !== hfeRender) return;
        const MaxAtATime = 100;
        const Delay = 30;
        // Read per batch: the filter can be typed into while this is still going.
        const filter = document.getElementById("hfe-filter").value.toLowerCase();
        for (const file of remaining.slice(0, MaxAtATime)) {
            const { title, publisher, detail } = describeHfe(file);
            const row = template.cloneNode(true);
            row.classList.remove("template");
            row.querySelector(".name").textContent = title;
            row.querySelector(".publisher").textContent = publisher;
            row.querySelector(".detail").textContent = detail;
            if (file.notes) row.title = file.notes;
            // The row is an anchor, and letting it navigate to "#" would push a
            // history entry of its own on top of the one updateUrl pushes.
            row.addEventListener("click", (event) => {
                event.preventDefault();
                hfeClick(file);
                $hfeModal.hide();
            });
            row.style.display = row.textContent.toLowerCase().includes(filter) ? "" : "none";
            list.appendChild(row);
        }
        if (remaining.length > MaxAtATime) setTimeout(() => addSome(remaining.slice(MaxAtATime)), Delay);
    };
    addSome(catalogue);
}

const $hfeModal = new bootstrap.Modal(document.getElementById("hfe"));
document.getElementById("hfe").addEventListener("shown.bs.modal", () => {
    document.getElementById("hfe-filter").focus();
});
document.getElementById("hfe").addEventListener("show.bs.modal", () => hfeArchive.populate());

const hfeFilter = document.getElementById("hfe-filter");
const onHfeFilter = () => filterArchiveList("hfe-list", hfeFilter.value);
hfeFilter.addEventListener("change", onHfeFilter);
hfeFilter.addEventListener("keyup", onHfeFilter);

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

function updateUrl() {
    const baseUrl = window.location.origin + window.location.pathname;
    const url = buildUrlFromParams(baseUrl, parsedQuery, paramTypes);
    window.history.pushState(null, null, url);
}

function splitImage(image) {
    const match = image.match(/(([^:]+):\/?\/?|[!^|])?(.*)/);
    const schema = match[2] || match[1] || "";
    image = match[3];
    return { image: image, schema: schema };
}

async function reloadSnapshotMedia(media) {
    if (!media) return;
    for (let driveIndex = 0; driveIndex < 2; driveIndex++) {
        const discKey = driveIndex === 0 ? "disc1" : "disc2";
        const imageDataKey = discKey + "ImageData";
        const crcKey = discKey + "Crc32";

        // A snapshot from before layout detection has no field, and was contiguous.
        const layout = media[discKey + "Layout"] ?? DiscLayout.contiguous;

        let loadedDisc = null;
        if (media[discKey]) {
            // URL-based disc — reload from source
            loadedDisc = await loadDiscImage(media[discKey], layout);
        } else if (media[imageDataKey]) {
            // Locally-loaded disc — reconstruct from embedded image data
            const imageData =
                media[imageDataKey] instanceof Uint8Array
                    ? media[imageDataKey]
                    : new Uint8Array(Object.values(media[imageDataKey]));
            const discName = media[discKey + "Name"] || "snapshot.ssd";
            loadedDisc = disc.discFor(processor.fdc, discName, imageData, undefined, layout);
            // Retain the image bytes so subsequent saves can re-embed them.
            loadedDisc.setOriginalImage(imageData);
        }
        if (!loadedDisc) continue;

        // Verify CRC32 if present
        if (media[crcKey] != null && loadedDisc.originalImageCrc32 != null) {
            if (loadedDisc.originalImageCrc32 !== media[crcKey]) {
                toast(
                    `${loadedDisc.name} has changed since this state was saved. The state has been restored anyway and may not run correctly.`,
                    { title: "Restoring state" },
                );
            }
        }

        putDiscIn(driveIndex, loadedDisc);
        // Only update the URL/query for URL-sourced discs. For embedded
        // (local-file) discs, setting parsedQuery would put a bogus source
        // in the URL and break subsequent saves/reloads.
        if (media[discKey]) {
            if (driveIndex === 0) setDisc1Image(media[discKey]);
            else setDisc2Image(media[discKey]);
        }
    }
}

async function loadDiscImage(discImage, layout = DiscLayout.auto) {
    if (!discImage) return null;
    const split = splitImage(discImage);
    discImage = split.image;
    const schema = split.schema;
    if (schema[0] === "!" || schema === "local") {
        return disc.localDisc(processor.fdc, discImage, layout);
    }
    // TODO: come up with a decent UX for passing an 'onChange' parameter to each of these.
    // Consider:
    // * hashing contents and making a local disc image named by original disc hash, save by that, and offer
    //   to load the modified disc on load.
    // * popping up a message that notes the disc has changed, and offers a way to make a local image
    // * Dialog box (ugh) saying "is this ok?"
    switch (schema) {
        case "|":
        case "sth": {
            const { name, data } = await discSth.fetch(discImage);
            return disc.discFor(processor.fdc, name, data, undefined, layout);
        }

        case "hfe":
            return disc.discFor(processor.fdc, discImage, await hfeArchive.fetch(discImage));

        case "gd": {
            const splat = discImage.match(/([^/]+)\/?(.*)/);
            let name = "(unknown)";
            if (splat) {
                discImage = splat[1];
                name = splat[2];
            }
            return gdLoad({ name, id: discImage }, layout);
        }
        case "b64data":
            return disc.discFor(processor.fdc, "disk.ssd", atob(discImage), undefined, layout);

        case "data": {
            const arr = Array.prototype.map.call(atob(discImage), (x) => x.charCodeAt(0));
            const { name, data } = await utils.unzipDiscImage(arr);
            return disc.discFor(processor.fdc, name, data, undefined, layout);
        }
        case "http":
        case "https":
        case "file": {
            const asUrl = `${schema}://${discImage}`;
            // url may end in query params etc, which can upset the DSD/SSD etc detection on the extension.
            discImage = new URL(asUrl).pathname;
            let discData = await utils.loadData(asUrl);
            if (/\.zip/i.test(discImage)) {
                const unzipped = await utils.unzipDiscImage(discData);
                discData = unzipped.data;
                discImage = unzipped.name;
            }
            return disc.discFor(processor.fdc, discImage, discData, undefined, layout);
        }
        default:
            return disc.discFor(processor.fdc, discImage, await disc.load("discs/" + discImage), undefined, layout);
    }
}

async function loadTapeImage(tapeImage) {
    const split = splitImage(tapeImage);
    tapeImage = split.image;
    const schema = split.schema;

    switch (schema) {
        case "|":
        case "sth": {
            const { name, data } = await tapeSth.fetch(tapeImage);
            return await loadTapeFromData(name, data, model);
        }

        case "data": {
            const arr = Array.prototype.map.call(atob(tapeImage), (x) => x.charCodeAt(0));
            const { name, data } = await utils.unzipDiscImage(arr);
            return await loadTapeFromData(name, data, model);
        }

        case "http":
        case "https":
        case "file": {
            const asUrl = `${schema}://${tapeImage}`;
            // url may end in query params etc, which can upset file handling
            tapeImage = new URL(asUrl).pathname;
            let tapeData = await utils.loadData(asUrl);
            if (/\.zip/i.test(tapeImage)) {
                const unzipped = await utils.unzipDiscImage(tapeData);
                tapeData = unzipped.data;
                tapeImage = unzipped.name;
            }
            return await loadTapeFromData(tapeImage, tapeData, model);
        }

        default: {
            const tapePath = "tapes/" + tapeImage;
            let tapeData = await utils.loadData(tapePath);
            let tapeName = tapeImage;
            if (/\.zip/i.test(tapeName)) {
                const unzipped = await utils.unzipDiscImage(tapeData);
                tapeData = unzipped.data;
                tapeName = unzipped.name;
            }
            return await loadTapeFromData(tapeName, tapeData, model);
        }
    }
}

document.getElementById("disc_load").addEventListener("change", async function (evt) {
    if (evt.target.files.length === 0) return;
    utils.noteEvent("local", "click"); // NB no filename here
    const file = evt.target.files[0];
    await loadHTMLFile(file);
    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

document.getElementById("fs_load").addEventListener("change", async function (evt) {
    if (evt.target.files.length === 0) return;
    utils.noteEvent("local", "click"); // NB no filename here
    const file = evt.target.files[0];
    await loadSCSIFile(file);
    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

document.getElementById("tape_load").addEventListener("change", async function (evt) {
    if (evt.target.files.length === 0) return;
    const file = evt.target.files[0];
    utils.noteEvent("local", "clickTape"); // NB no filename here

    let tapeData = await readFileAsBinaryString(file);
    let tapeName = file.name;
    if (/\.zip/i.test(tapeName)) {
        const unzipped = await utils.unzipDiscImage(utils.stringToUint8Array(tapeData));
        tapeData = unzipped.data;
        tapeName = unzipped.name;
    }
    setProcessorTape(await loadTapeFromData(tapeName, tapeData, model));
    delete parsedQuery.tape;
    updateUrl();
    bootstrap.Modal.getInstance(document.getElementById("tapes"))?.hide();

    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

function anyModalsVisible() {
    return document.querySelectorAll(".modal.show").length !== 0;
}

let modalSavedRunning = false;
document.addEventListener("show.bs.modal", function () {
    if (!anyModalsVisible()) modalSavedRunning = running;
    if (running) stop(false);
});
document.addEventListener("hidden.bs.modal", function () {
    if (!anyModalsVisible() && modalSavedRunning) {
        go();
    }
});

const loadingDialog = document.getElementById("loading-dialog");
const loadingDialogModal = new bootstrap.Modal(loadingDialog);
const googleDriveAuth = document.getElementById("google-drive-auth");

function popupLoading(msg) {
    loadingDialog.querySelector(".loading").textContent = msg;
    googleDriveAuth.style.display = "none";
    loadingDialogModal.show();
}

function loadingFinished(message) {
    googleDriveAuth.style.display = "none";
    loadingDialogModal.hide();
    if (message) toast(message);
}

const googleDrive = new GoogleDriveLoader();
const googleDriveEl = document.getElementById("google-drive");

async function gdAuth(imm) {
    try {
        return await googleDrive.authorize(imm);
    } catch (err) {
        console.log("Error handling google auth: " + err);
        googleDriveEl.querySelector(".loading").textContent =
            "There was an error accessing your Google Drive account: " + err;
    }
}

let googleDriveLoadingResolve, googleDriveLoadingReject;
document.querySelector("#google-drive-auth form").addEventListener("submit", async function (e) {
    googleDriveAuth.style.display = "none";
    e.preventDefault();
    const authed = await gdAuth(false);
    if (authed) googleDriveLoadingResolve();
    else googleDriveLoadingReject(new Error("Unable to authorize Google Drive"));
});

async function gdLoad(cat, layout) {
    // TODO: have a onclose flush event, handle errors
    /*
     $(window).bind("beforeunload", function() {
     return confirm("Do you really want to close?");
     });
     */
    popupLoading("Loading '" + cat.name + "' from Google Drive");
    try {
        const available = await googleDrive.initialise();
        console.log("Google Drive available =", available);
        if (!available) throw new Error("Google Drive is not available");

        const authed = await gdAuth(true);
        console.log("Google Drive authed=", authed);

        if (!authed) {
            await new Promise(function (resolve, reject) {
                googleDriveLoadingResolve = resolve;
                googleDriveLoadingReject = reject;
                googleDriveAuth.style.display = "";
            });
        }

        const ssd = await googleDrive.load(processor.fdc, cat.id, layout);
        console.log("Google Drive loading finished");
        loadingFinished();
        return ssd;
    } catch (error) {
        console.error("Google Drive loading error:", error);
        loadingFinished(`Unable to load ${cat.name} from Google Drive: ${errorText(error)}`);
    }
}

for (const el of document.querySelectorAll(".if-drive-available")) el.style.display = "none";
(async () => {
    try {
        const available = await googleDrive.initialise();
        if (available) {
            for (const el of document.querySelectorAll(".if-drive-available")) el.style.display = "";
            await gdAuth(true);
        }
    } catch (error) {
        console.log(`Google Drive is unavailable: ${errorText(error)}`);
    }
})();
const googleDriveModal = new bootstrap.Modal(googleDriveEl);
document.getElementById("open-drive-link").addEventListener("click", async function () {
    const authed = await gdAuth(false);
    if (authed) {
        googleDriveModal.show();
    }
    return false;
});
googleDriveEl.addEventListener("show.bs.modal", async function () {
    const gdLoading = googleDriveEl.querySelector(".loading");
    gdLoading.textContent = "Loading...";
    gdLoading.style.display = "";
    for (const el of googleDriveEl.querySelectorAll("li:not(.template)")) el.remove();
    const cat = await googleDrive.listFiles();
    const dbList = googleDriveEl.querySelector(".list");
    gdLoading.style.display = "none";
    const template = dbList.querySelector(".template");
    for (const item of cat) {
        const row = template.cloneNode(true);
        row.classList.remove("template");
        dbList.appendChild(row);
        row.querySelector(".name").textContent = item.name;
        row.addEventListener("click", async function () {
            utils.noteEvent("google-drive", "click", item.name);
            setDisc1Image(`gd:${item.id}/${item.name}`);
            googleDriveModal.hide();
            const ssd = await gdLoad(item, layoutForDrive(0));
            if (ssd) putDiscIn(0, ssd);
        });
    }
});
const discList = document.getElementById("disc-list");
const discTemplate = discList.querySelector(".template");
for (const image of availableImages) {
    const elem = discTemplate.cloneNode(true);
    elem.classList.remove("template");
    discList.appendChild(elem);
    elem.querySelector(".name").textContent = image.name;
    elem.querySelector(".description").textContent = image.desc;
    elem.addEventListener("click", async function () {
        utils.noteEvent("images", "click", image.file);
        setDisc1Image(image.file);
        $discsModal.hide();
        putDiscIn(0, await loadDiscImage(parsedQuery.disc1, layoutForDrive(0)));
    });
}

document.querySelector("#google-drive form").addEventListener("submit", async function (e) {
    e.preventDefault();
    let name = document.querySelector("#google-drive .disc-name").value;
    if (!name) return;

    popupLoading("Connecting to Google Drive");
    googleDriveModal.hide();
    popupLoading("Creating '" + name + "' on Google Drive");

    let data;
    if (document.querySelector("#google-drive .create-from-existing").checked) {
        const discType = disc.guessDiscTypeFromName(name);
        try {
            data = discType.saver(processor.fdc.drives[0].disc);
        } catch (e) {
            loadingFinished(`Unable to create ${name} on Google Drive: ${errorText(e)}`);
            return;
        }
        name = replaceOrAddExtension(name, discType.extension);
        console.log(`Saving existing disc: ${name}`);
    } else {
        // TODO support HFE, I guess?
        const discType = disc.guessDiscTypeFromName(name);
        if (!discType.byteSize) {
            throw new Error(`Cannot create blank disc of type ${discType.extension} - unknown size`);
        }
        data = new Uint8Array(discType.byteSize);
        if (discType.supportsCatalogue) {
            discType.setDiscName(data, name);
        }
        console.log(`Creating blank: ${name}`);
    }

    try {
        const result = await googleDrive.create(processor.fdc, name, data);
        setDisc1Image("gd:" + result.fileId + "/" + name);
        putDiscIn(0, result.disc);
        loadingFinished();
    } catch (error) {
        console.error(`Error creating Google Drive disc: ${error}`, error);
        loadingFinished(`Unable to create ${name} on Google Drive: ${errorText(error)}`);
    }
});

document.getElementById("download-drive-link").addEventListener("click", function () {
    const disc = processor.fdc.drives[0].disc;
    const save = (options) =>
        downloadDriveData(toSsdOrDsd(disc, options), disc.name, disc.isDoubleSided ? ".dsd" : ".ssd");
    try {
        save();
    } catch (e) {
        areYouSure(`${e.message} Save anyway, losing what will not fit?`, "Save anyway", "Cancel", () =>
            save({ force: true }),
        );
    }
});

document.getElementById("download-drive-hfe-link").addEventListener("click", function () {
    const disc = processor.fdc.drives[0].disc;
    const data = toHfe(disc);
    const name = disc.name;

    downloadDriveData(data, name, ".hfe");
});

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
        showError("saving state", e);
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
            const newQuery = { ...parsedQuery, model: snapshot.model, coProcessor: hasCoProcessor(snapshot) };
            const baseUrl = window.location.origin + window.location.pathname;
            window.location.href = buildUrlFromParams(baseUrl, newQuery, paramTypes);
            return;
        }
        // Order matters: reload disc media first so the base disc is in the
        // drive before restoreSnapshot applies dirty track overlays on top.
        await reloadSnapshotMedia(snapshot.media);
        restoreSnapshot(processor, model, snapshot);
        // Force a repaint so the display updates even while paused
        video.paint();
    } catch (e) {
        showError("loading state", e);
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
                console.error(`Error loading ${description}:`, error);
                toast(`Could not load ${description}: ${error?.message ?? error}`, { title: "Loading" });
            }
        })();
        imageLoads.push(loading);
        return loading;
    }

    if (discImage) {
        startImageLoad(`disc ${discImage}`, async () =>
            putDiscIn(0, await loadDiscImage(discImage, layoutForDrive(0))),
        );
    }

    if (secondDiscImage) {
        startImageLoad(`disc ${secondDiscImage}`, async () =>
            putDiscIn(1, await loadDiscImage(secondDiscImage, layoutForDrive(1))),
        );
    }

    if (parsedQuery.tape) {
        startImageLoad(`tape ${parsedQuery.tape}`, async () => setProcessorTape(await loadTapeImage(parsedQuery.tape)));
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
                showAutoboot(true);
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
                showAutoboot(false);
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
                showError("restoring saved state", e);
            }
        }

        go();
    } catch (error) {
        console.error("Error initialising emulator:", error);
        showError("initialising", error);
    }
})();

const aysEl = document.getElementById("are-you-sure");
const aysModal = new bootstrap.Modal(aysEl);

function areYouSure(message, yesText, noText, yesFunc) {
    const yesButton = aysEl.querySelector(".ays-yes");
    aysEl.querySelector(".context").textContent = message;
    aysEl.querySelector(".ays-no").textContent = noText;
    yesButton.textContent = yesText;
    let confirmed = false;
    const onYes = () => {
        confirmed = true;
        aysModal.hide();
    };
    yesButton.addEventListener("click", onYes, { once: true });
    // The "no" button, Escape and a click outside raise no event of their own: they only hide the modal.
    aysEl.addEventListener(
        "hidden.bs.modal",
        () => {
            yesButton.removeEventListener("click", onYes);
            if (confirmed) yesFunc();
        },
        { once: true },
    );
    aysModal.show();
}

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
let rewindFrameCounter = 0;
const RewindCaptureInterval = 50; // ~1 second at 50fps

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

for (const item of document.querySelectorAll(".drive-tracks")) {
    const driveIndex = Number(item.dataset.drive);
    const drive = processor.fdc?.drives[driveIndex];
    const fixed = drive ? tracksPerStepForDrive(driveIndex) : undefined;
    if (fixed !== undefined) drive.tracksPerStep = fixed;
    for (const button of driveTracksButtons(driveIndex)) {
        button.disabled = !drive;
        button.addEventListener("click", (event) => {
            // Setting a switch is not picking from a menu, so leave the menu where it is.
            event.stopPropagation();
            drive.tracksPerStep = tracksPerStepFor(button.dataset.tracks);
            showDriveTracks(driveIndex);
        });
    }
    if (drive) showDriveTracks(driveIndex);
}

function draw(now) {
    if (!running) {
        last = 0;
        return;
    }
    // If we got here via setTimeout, we don't get passed the time.
    if (now === undefined) {
        now = window.performance.now();
    }

    const motorOn = processor.acia.motorOn;
    const discOn = processor.fdc.motorOn[0] || processor.fdc.motorOn[1];
    const speedy = fastAsPossible || (fastTape && motorOn);
    const useTimeout = speedy || motorOn || discOn;
    const timeout = speedy ? 0 : 1000.0 / 50;

    // In speedy mode, we still run all the state machines accurately
    // but we paint less often because painting is the most expensive
    // part of jsbeeb at this time.
    // We need need to paint per odd number of frames so that interlace
    // modes, i.e. MODE 7, still look ok.
    video.frameSkipCount = speedy ? 9 : 0;

    // We use setTimeout instead of requestAnimationFrame in two cases:
    // a) We're trying to run as fast as possible.
    // b) Tape is playing, normal speed but backgrounded tab should run.
    if (useTimeout) {
        window.setTimeout(draw, timeout);
    } else {
        window.requestAnimationFrame(draw);
    }

    audioHandler.soundChip.catchUp();
    gamepad.update(processor.sysvia);
    syncLights();
    if (last !== 0) {
        let cycles;
        if (!speedy) {
            // Now and last are DOMHighResTimeStamp, just a double.
            const sinceLast = now - last;
            cycles = (sinceLast * clocksPerSecond) / 1000;
            cycles = Math.min(cycles, MaxCyclesPerFrame);
        } else {
            cycles = clocksPerSecond / 50;
        }
        cycles |= 0;
        try {
            if (!processor.execute(cycles)) {
                stop(true);
            }
            const end = performance.now();
            virtualSpeedUpdater.update(cycles, end - now, speedy);
            // Capture rewind snapshot periodically
            if (++rewindFrameCounter >= RewindCaptureInterval) {
                rewindFrameCounter = 0;
                rewindBuffer.push(processor.snapshotState());
                rewindUI.updateButtonState();
            }
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
    last = now;
}

function run() {
    window.requestAnimationFrame(draw);
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

const $infoModal = new bootstrap.Modal(document.getElementById("info"));
const $ppTosModal = new bootstrap.Modal(document.getElementById("pp-tos"));

if (Object.hasOwn(parsedQuery, "about")) {
    $infoModal.show();
}
if (Object.hasOwn(parsedQuery, "pp-tos")) {
    $ppTosModal.show();
}

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
    loadDiscImage,
    loadTapeImage,
    processor,
    config,
    modals: {
        show: (modalId, sthType) => {
            if (modalId === "sth" && sthType) {
                if (sthType === "discs") discSth.populate();
                else if (sthType === "tapes") tapeSth.populate();
            }
            const modalEl = document.getElementById(modalId);
            if (modalEl) {
                const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
                modal.show();
            }
        },
    },
    loadStateFile: loadStateFromFile,
    actions: {
        "soft-reset": () => processor.reset(false),
        "hard-reset": hardReset,
        "save-state": () => document.getElementById("save-state").click(),
        rewind: () => rewindUI.open(),
    },
});

// Display version in About dialog
const versionElement = document.getElementById("jsbeeb-version");
if (versionElement) {
    versionElement.textContent = `Version ${version}`;
}
