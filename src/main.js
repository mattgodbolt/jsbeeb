import * as bootstrap from "bootstrap";
import { version } from "../package.json";

import "bootswatch/dist/darkly/bootstrap.min.css";
import "./jsbeeb.css";

import * as utils from "./utils.js";
import { FakeVideo, Video } from "./video.js";
import { Debugger } from "./web/debug.js";
import { Cpu6502, AtomCpu6502 } from "./6502.js";
import { Video6847 } from "./6847.js";
import * as utils_atom from "./utils_atom.js";
import { LoadSD } from "./mmc.js";
import { Cmos } from "./cmos.js";
import { StairwayToHell } from "./sth.js";
import { GamePad } from "./gamepads.js";
import * as disc from "./fdc.js";
import { loadTape, loadTapeFromData } from "./tapes.js";
import { GoogleDriveLoader } from "./google-drive.js";
import * as tokeniser from "./basic-tokenise.js";
import * as canvasLib from "./canvas.js";
import { Config } from "./config.js";
import { initialise as electron } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { Econet } from "./econet.js";
import { toSsdOrDsd } from "./disc.js";
import { toHfe } from "./disc-hfe.js";
import { Keyboard } from "./keyboard.js";
import { GamepadSource } from "./gamepad-source.js";
import { MicrophoneInput } from "./microphone-input.js";
import { SpeechOutput } from "./speech-output.js";
import { MouseJoystickSource } from "./mouse-joystick-source.js";
import { getFilterForMode } from "./canvas.js";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON, isSameModel } from "./snapshot.js";
import { isBemSnapshot, parseBemSnapshot } from "./bem-snapshot.js";
import { isUefSnapshot, parseUefSnapshot } from "./uef-snapshot.js";
import { RewindBuffer } from "./rewind.js";
import { RewindUI } from "./rewind-ui.js";
import {
    buildUrlFromParams,
    guessModelFromHostname,
    ParamTypes,
    parseMediaParams,
    parseQueryString,
    processAutobootParams,
    processKeyboardParams,
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
    tubeCpuMultiplier: ParamTypes.INT,
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
};

// Parse the query string with parameter types
let parsedQuery = parseQueryString(queryString, paramTypes);
let { needsAutoboot, autoType } = processAutobootParams(parsedQuery);
let keyLayout = window.localStorage.keyLayout || "physical";

const BBC = utils.BBC;
const keyCodes = utils.keyCodes;
let cpuMultiplier = 1;
let fastAsPossible = false;
let fastTape = false;
let noSeek;
let audioFilterFreq = 7000;
let audioFilterQ = 5;
let stationId = 101;
let econet = null;

// Parse disc and tape images from query parameters
const { discImage: queryDiscImage, secondDiscImage: querySecondDisc, mmcImage } = parseMediaParams(parsedQuery);

// Only assign if values are provided
if (queryDiscImage) discImage = queryDiscImage;
if (querySecondDisc) secondDiscImage = querySecondDisc;

// Process keyboard mappings
parsedQuery = processKeyboardParams(parsedQuery, BBC, keyCodes, utils.userKeymap, gamepad);

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

const emulationConfig = {
    keyLayout: keyLayout,
    coProcessor: parsedQuery.coProcessor,
    cpuMultiplier: cpuMultiplier,
    tubeCpuMultiplier: parsedQuery.tubeCpuMultiplier || 2,
    videoCyclesBatch: parsedQuery.videoCyclesBatch,
    extraRoms: extraRoms,
    userPort: userPort,
    printerPort: printerPort,
    getGamepads: function () {
        // Gamepads are only available in secure contexts. If e.g. loading from http:// urls they aren't there.
        return navigator.getGamepads ? navigator.getGamepads() : [];
    },
    debugFlags: {
        logFdcCommands: parsedQuery.logFdcCommands !== undefined,
        logFdcStateChanges: parsedQuery.logFdcStateChanges !== undefined,
    },
};

// Speech output: initialised from URL param; can be toggled at runtime via the Settings panel.
// Must be created before Config so the onClose callback and setSpeechOutput() call can reference it.
const speechOutput = new SpeechOutput();
speechOutput.enabled = !!parsedQuery.speechOutput;

const config = new Config(
    function onChange(changed) {
        if (changed.displayMode) {
            displayModeFilter = getFilterForMode(changed.displayMode);
            setCrtPic(displayModeFilter);
            swapCanvas(displayModeFilter);
            // Trigger window resize to recalculate layout with new dimensions
            window.dispatchEvent(new Event("resize"));
        }
    },
    function onClose(changed) {
        parsedQuery = Object.assign(parsedQuery, changed);
        if (
            changed.model ||
            changed.coProcessor !== undefined ||
            changed.hasMusic5000 !== undefined ||
            changed.hasTeletextAdaptor !== undefined ||
            changed.hasEconet !== undefined
        ) {
            areYouSure(
                "Changing model requires a restart of the emulator. Restart now?",
                "Yes, restart now",
                "No, thanks",
                function () {
                    updateUrl();
                    window.location.reload();
                },
            );
        }
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
            if (processor.tube && processor.tube.cpuMultiplier !== undefined) {
                processor.tube.cpuMultiplier = changed.tubeCpuMultiplier;
            }
        }
        updateUrl();
    },
);

// Perform mapping of legacy models to the new format
config.mapLegacyModels(parsedQuery);

config.setModel(parsedQuery.model || guessModelFromHostname(window.location.hostname));
config.setKeyLayout(keyLayout);
config.set65c02(parsedQuery.coProcessor);
config.setTubeCpuMultiplier(parsedQuery.tubeCpuMultiplier || 2);
config.setEconet(parsedQuery.hasEconet);
config.setMusic5000(parsedQuery.hasMusic5000);
config.setTeletext(parsedQuery.hasTeletextAdaptor);
config.setMicrophoneChannel(parsedQuery.microphoneChannel);
config.setMouseJoystickEnabled(parsedQuery.mouseJoystickEnabled);
config.setSpeechOutput(speechOutput.enabled);
let displayMode = parsedQuery.displayMode || "rgb";
config.setDisplayMode(displayMode);

model = config.model;

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

if (parsedQuery.cpuMultiplier !== undefined) {
    cpuMultiplier = parsedQuery.cpuMultiplier;
    console.log("CPU multiplier set to " + cpuMultiplier);
}
const cpuSpeed = model.isAtom ? 1 * 1000 * 1000 : 2 * 1000 * 1000;
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

function createCanvasForFilter(filterClass) {
    const newCanvas = tryGl ? canvasLib.bestCanvas(screenCanvas, filterClass) : new canvasLib.Canvas(screenCanvas);

    if (filterClass.requiresGl() && !newCanvas.isWebGl()) {
        const config = filterClass.getDisplayConfig();
        showError(`enabling ${config.name} mode`, `${config.name} requires WebGL. Using standard display instead.`);
    }

    return newCanvas;
}

let displayModeFilter = canvasLib.getFilterForMode(parsedQuery.displayMode || "rgb");
function swapCanvas(newFilterClass) {
    const newCanvas = createCanvasForFilter(newFilterClass);
    video.fb32 = newCanvas.fb32;
    video.paint_ext = function paint(minx, miny, maxx, maxy) {
        frames++;
        if (frames < frameSkip) return;
        frames = 0;
        newCanvas.paint(minx, miny, maxx, maxy, this.frameCount);
    };
    canvas = newCanvas;
    displayModeFilter = newFilterClass;
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 1);
}

let canvas = createCanvasForFilter(displayModeFilter);

video = new Video(model.isMaster, canvas.fb32, function paint(minx, miny, maxx, maxy) {
    frames++;
    if (frames < frameSkip) return;
    frames = 0;
    canvas.paint(minx, miny, maxx, maxy, this.frameCount);
});
if (parsedQuery.fakeVideo !== undefined) video = new FakeVideo();

// Atom: attach the MC6847 VDG to the video system
if (model.isAtom) {
    video.video6847 = new Video6847(video);
    video.polltime = video.video6847.polltimeFacade;
}

const audioStatsEl = document.getElementById("audio-stats");
if (audioStatsEl) audioStatsEl.hidden = !parsedQuery.audioDebug;
const audioStatsNode = parsedQuery.audioDebug ? audioStatsEl : null;
const audioHandler = new AudioHandler({
    warningNode: document.getElementById("audio-warning"),
    statsNode: audioStatsNode,
    audioFilterFreq,
    audioFilterQ,
    noSeek,
});
// Firefox will report that audio is suspended even when it will
// start playing without user interaction, so we need to delay a
// little to get a reliable indication.
window.setTimeout(() => audioHandler.checkStatus(), 1000);

// Atom: configure soundchip for 1 MHz CPU and speaker output
if (model.isAtom) {
    audioHandler.soundChip.setCPUSpeed(cpuSpeed);
    audioHandler.soundChip.isAtom = true;
}

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
    const a = document.createElement("a");
    document.body.appendChild(a);
    a.style = "display: none";

    const fileName = replaceOrAddExtension(name, extension);
    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = window.URL.createObjectURL(blob);

    a.href = url;
    a.download = fileName;
    a.click();
    window.URL.revokeObjectURL(url);
}

async function loadHTMLFile(file) {
    const imageData = utils.stringToUint8Array(await readFileAsBinaryString(file));
    const loadedDisc = disc.discFor(processor.fdc, file.name, imageData);
    // Local file: retain the image bytes for embedding in save-to-file snapshots.
    loadedDisc.setOriginalImage(imageData);
    processor.fdc.loadDisc(0, loadedDisc);
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
    sendRawKeyboardToBBC(stringToMachineKeys(text), true);
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
        setProcessorTape(loadTapeFromData(file.name, new Uint8Array(arrayBuffer), model.isAtom));
    } else {
        await loadHTMLFile(file);
    }
});

const cubMonitor = document.getElementById("cub-monitor");
function onCubMouseEvent(evt) {
    audioHandler.tryResume();
    if (document.activeElement !== document.body) document.activeElement.blur();
    const cubRect = cubMonitor.getBoundingClientRect();
    const screenRect = screenCanvas.getBoundingClientRect();
    const x = (evt.offsetX - cubRect.left + screenRect.left) / screenCanvas.offsetWidth;
    const y = (evt.offsetY - cubRect.top + screenRect.top) / screenCanvas.offsetHeight;

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

if (model.hasEconet) {
    econet = new Econet(stationId);
} else {
    document.getElementById("fsmenuitem").style.display = "none";
}

const cmos = new Cmos(
    {
        load: function () {
            if (window.localStorage.cmosRam) {
                return JSON.parse(window.localStorage.cmosRam);
            }
            return null;
        },
        save: function (data) {
            window.localStorage.cmosRam = JSON.stringify(data);
        },
    },
    model.cmosOverride,
    econet,
);

let printerWindow = null;
let printerTextArea = null;

function checkPrinterWindow() {
    if (printerWindow && !printerWindow.closed) return;

    printerWindow = window.open("", "_blank", "height=300,width=400");
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
    music5000: model.hasMusic5000 ? audioHandler.music5000 : null,
    cmos,
    config: emulationConfig,
    econet,
});

// Create input sources
const gamepadSource = new GamepadSource(emulationConfig.getGamepads);
// Create MicrophoneInput but don't enable by default
const microphoneInput = new MicrophoneInput();
microphoneInput.setErrorCallback((message) => {
    showError("accessing microphone", message);
});

// Create MouseJoystickSource but don't enable by default
const mouseJoystickSource = new MouseJoystickSource(screenCanvas);

/**
 * Attach an RS-423 composite handler to the ACIA that combines the touchscreen
 * (which sends position data to the BBC) with the speech output (which speaks
 * text the BBC sends out).  Call this once after processor.initialise() and
 * again whenever speechOutput.enabled changes.
 */
function setupRs423Handler() {
    const touchScreen = processor.touchScreen;
    processor.acia.setRs423Handler({
        onTransmit(val) {
            touchScreen.onTransmit(val);
            speechOutput.onTransmit(val);
        },
        tryReceive(rts) {
            return touchScreen.tryReceive(rts);
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
keyboard.addEventListener("showError", (e) => showError(e.detail.context, e.detail.error));
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

function sthClearList() {
    for (const el of document.querySelectorAll("#sth-list li:not(.template)")) el.remove();
}

function sthStartLoad() {
    const sthLoading = document.querySelector("#sth .loading");
    sthLoading.textContent = "Loading catalog from STH archive";
    sthLoading.style.display = "";
    sthClearList();
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
        const disc = await loadDiscImage(parsedQuery.disc1);
        processor.fdc.loadDisc(0, disc);
        loadingFinished();

        if (needsAutoboot) {
            autoboot(item);
        }
    } catch (err) {
        console.error("Error loading disc image:", err);
        loadingFinished(err);
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
        loadingFinished(err);
    }
}

const $sthModal = new bootstrap.Modal(document.getElementById("sth"));
document.getElementById("sth").addEventListener("shown.bs.modal", () => {
    document.getElementById("sth-filter").focus();
});

function makeOnCat(onClick) {
    return function (cat) {
        sthClearList();
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
    const sthLoading = document.querySelector("#sth .loading");
    sthLoading.textContent = "There was an error accessing the STH archive";
    sthLoading.style.display = "";
    sthClearList();
}

discSth = new StairwayToHell(sthStartLoad, makeOnCat(discSthClick), sthOnError, false);
tapeSth = new StairwayToHell(sthStartLoad, makeOnCat(tapeSthClick), sthOnError, true);

const sthAutoboot = document.querySelector("#sth .autoboot");
sthAutoboot.addEventListener("click", function () {
    if (sthAutoboot.checked) {
        parsedQuery.autoboot = "";
    } else {
        delete parsedQuery.autoboot;
    }
    updateUrl();
});

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
    filter = filter.toLowerCase();
    for (const el of document.querySelectorAll("#sth-list li:not(.template)")) {
        el.style.display = el.textContent.toLowerCase().indexOf(filter) >= 0 ? "" : "none";
    }
}

const sthFilter = document.getElementById("sth-filter");
sthFilter.addEventListener("change", () => setSthFilter(sthFilter.value));
sthFilter.addEventListener("keyup", () => setSthFilter(sthFilter.value));

function sendRawKeyboardToBBC(keysToSend, checkCapsAndShiftLocks) {
    if (keyboard) {
        keyboard.sendRawKeyboardToBBC(keysToSend, checkCapsAndShiftLocks);
    } else {
        console.warn("Tried to send keys before keyboard was initialised");
    }
}

function autoboot(image) {
    const BBC = utils.BBC;

    console.log("Autobooting disc");
    utils.noteEvent("init", "autoboot", image);

    // Shift-break simulation, hold SHIFT for 1000ms.
    sendRawKeyboardToBBC([BBC.SHIFT, 1000], false);
}

function autoBootType(keys) {
    console.log("Auto typing '" + keys + "'");
    utils.noteEvent("init", "autochain");

    const bbcKeys = stringToMachineKeys(keys);
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
}

function autoChainTape() {
    console.log("Auto Chaining Tape");
    utils.noteEvent("init", "autochain");

    const bbcKeys = stringToMachineKeys('*TAPE\nCH.""\n');
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
}

function autoRunTape() {
    console.log("Auto Running Tape");
    utils.noteEvent("init", "autorun");

    const bbcKeys = stringToMachineKeys("*TAPE\n*/\n");
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
}

function autoRunBasic() {
    console.log("Auto Running basic");
    utils.noteEvent("init", "autorunbasic");

    const bbcKeys = stringToMachineKeys("RUN\n");
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
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

        let loadedDisc = null;
        if (media[discKey]) {
            // URL-based disc — reload from source
            loadedDisc = await loadDiscImage(media[discKey]);
        } else if (media[imageDataKey]) {
            // Locally-loaded disc — reconstruct from embedded image data
            const imageData =
                media[imageDataKey] instanceof Uint8Array
                    ? media[imageDataKey]
                    : new Uint8Array(Object.values(media[imageDataKey]));
            const discName = media[discKey + "Name"] || "snapshot.ssd";
            loadedDisc = disc.discFor(processor.fdc, discName, imageData);
            // Retain the image bytes so subsequent saves can re-embed them.
            loadedDisc.setOriginalImage(imageData);
        }
        if (!loadedDisc) continue;

        // Verify CRC32 if present
        if (media[crcKey] != null && loadedDisc.originalImageCrc32 != null) {
            if (loadedDisc.originalImageCrc32 !== media[crcKey]) {
                showError(
                    "loading state",
                    "The disc image appears to have changed since this snapshot was saved. The restored state may not work correctly.",
                );
            }
        }

        processor.fdc.loadDisc(driveIndex, loadedDisc);
        // Only update the URL/query for URL-sourced discs. For embedded
        // (local-file) discs, setting parsedQuery would put a bogus source
        // in the URL and break subsequent saves/reloads.
        if (media[discKey]) {
            if (driveIndex === 0) setDisc1Image(media[discKey]);
            else setDisc2Image(media[discKey]);
        }
    }
}

async function loadDiscImage(discImage) {
    if (!discImage) return null;
    const split = splitImage(discImage);
    discImage = split.image;
    const schema = split.schema;
    if (schema[0] === "!" || schema === "local") {
        return disc.localDisc(processor.fdc, discImage);
    }
    // TODO: come up with a decent UX for passing an 'onChange' parameter to each of these.
    // Consider:
    // * hashing contents and making a local disc image named by original disc hash, save by that, and offer
    //   to load the modified disc on load.
    // * popping up a message that notes the disc has changed, and offers a way to make a local image
    // * Dialog box (ugh) saying "is this ok?"
    switch (schema) {
        case "|":
        case "sth":
            return disc.discFor(processor.fdc, discImage, await discSth.fetch(discImage));

        case "gd": {
            const splat = discImage.match(/([^/]+)\/?(.*)/);
            let name = "(unknown)";
            if (splat) {
                discImage = splat[1];
                name = splat[2];
            }
            return gdLoad({ name, id: discImage });
        }
        case "b64data":
            return disc.discFor(processor.fdc, "disk.ssd", atob(discImage));

        case "data": {
            const arr = Array.prototype.map.call(atob(discImage), (x) => x.charCodeAt(0));
            const { name, data } = await utils.unzipDiscImage(arr);
            return disc.discFor(processor.fdc, name, data);
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
            return disc.discFor(processor.fdc, discImage, discData);
        }
        default:
            return disc.discFor(processor.fdc, discImage, await disc.load("discs/" + discImage));
    }
}

async function loadTapeImage(tapeImage) {
    const split = splitImage(tapeImage);
    tapeImage = split.image;
    const schema = split.schema;
    const isAtom = model.isAtom;

    switch (schema) {
        case "|":
        case "sth":
            return await loadTapeFromData(tapeImage, await tapeSth.fetch(tapeImage), isAtom);

        case "data": {
            const arr = Array.prototype.map.call(atob(tapeImage), (x) => x.charCodeAt(0));
            const { name, data } = await utils.unzipDiscImage(arr);
            return await loadTapeFromData(name, data, isAtom);
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
            return await loadTapeFromData(tapeImage, tapeData, isAtom);
        }

        default:
            return await loadTape("tapes/" + tapeImage, isAtom);
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

    const binaryData = await readFileAsBinaryString(file);
    setProcessorTape(await loadTapeFromData("local file", binaryData, model.isAtom));
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

function loadingFinished(error) {
    googleDriveAuth.style.display = "none";
    if (error) {
        loadingDialogModal.show();
        loadingDialog.querySelector(".loading").textContent = "Error: " + error;
        setTimeout(function () {
            loadingDialogModal.hide();
        }, 5000);
    } else {
        loadingDialogModal.hide();
    }
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

async function gdLoad(cat) {
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

        const ssd = await googleDrive.load(processor.fdc, cat.id);
        console.log("Google Drive loading finished");
        loadingFinished();
        return ssd;
    } catch (error) {
        console.error("Google Drive loading error:", error);
        loadingFinished(error);
    }
}

for (const el of document.querySelectorAll(".if-drive-available")) el.style.display = "none";
(async () => {
    const available = await googleDrive.initialise();
    if (available) {
        for (const el of document.querySelectorAll(".if-drive-available")) el.style.display = "";
        await gdAuth(true);
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
            const ssd = await gdLoad(item);
            if (ssd) processor.fdc.loadDisc(0, ssd);
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
        processor.fdc.loadDisc(0, await loadDiscImage(parsedQuery.disc1));
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
        data = discType.saver(processor.fdc.drives[0].disc);
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
        processor.fdc.loadDisc(0, result.disc);
        loadingFinished();
    } catch (error) {
        console.error(`Error creating Google Drive disc: ${error}`, error);
        loadingFinished(`Create failed: ${error}`);
    }
});

document.getElementById("download-drive-link").addEventListener("click", function () {
    const disc = processor.fdc.drives[0].disc;
    const data = toSsdOrDsd(disc);
    const name = disc.name;
    const extension = disc.isDoubleSided ? ".dsd" : ".ssd";

    downloadDriveData(data, name, extension);
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
            if (!media[discKey] && driveDisc.originalImageData) {
                media[discKey + "ImageData"] = driveDisc.originalImageData;
                media[discKey + "Name"] = driveDisc.name;
            }
        }

        const snapshot = createSnapshot(processor, model, Object.keys(media).length > 0 ? media : undefined);
        const json = snapshotToJSON(snapshot);
        const blob = await compressBlob(new Blob([json]));
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const a = document.createElement("a");
        a.href = url;
        a.download = `jsbeeb-${model.name}-${timestamp}.json.gz`;
        a.click();
        URL.revokeObjectURL(url);
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
        if (!isSameModel(snapshot.model, model.name)) {
            // Model mismatch: stash state and reload with correct model
            sessionStorage.setItem("jsbeeb-pending-state", snapshotToJSON(snapshot));
            const newQuery = { ...parsedQuery, model: snapshot.model };
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
            processor.acia.rewindTape();
        } else {
            console.log("unknown type", type);
        }
    });
}

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
    caps.update(processor.sysvia.capsLockLight);
    shift.update(processor.sysvia.shiftLockLight);
    drive0.update(processor.fdc.motorOn[0]);
    drive1.update(processor.fdc.motorOn[1]);
    cassette.update(processor.acia.motorOn);
    if (model.hasEconet) {
        network.update(processor.econet.activityLight());
    }
};

const startPromise = (async () => {
    await Promise.all([audioHandler.initialise(), processor.initialise()]);

    // Wire up the composite RS-423 handler now that the touchscreen exists.
    setupRs423Handler();

    // Ideally would start the loads first. But their completion needs the FDC from the processor
    const imageLoads = [];

    if (discImage) {
        imageLoads.push(
            (async () => {
                const disc = await loadDiscImage(discImage);
                processor.fdc.loadDisc(0, disc);
            })(),
        );
    }

    if (secondDiscImage) {
        imageLoads.push(
            (async () => {
                const disc = await loadDiscImage(secondDiscImage);
                processor.fdc.loadDisc(1, disc);
            })(),
        );
    }

    if (parsedQuery.tape) {
        imageLoads.push(
            (async () => {
                const tape = await loadTapeImage(parsedQuery.tape);
                setProcessorTape(tape);
            })(),
        );
    }

    if (mmcImage && model.isAtom && processor.atommc) {
        imageLoads.push(
            (async () => {
                const files = await LoadSD(mmcImage);
                processor.atommc.SetMMCData(files);
            })(),
        );
    }

    async function insertBasic(getBasicPromise, needsRun) {
        const basicLoadPromise = (async () => {
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
            return tokenised; // Explicitly return the result
        })();

        imageLoads.push(basicLoadPromise);
        return basicLoadPromise; // Return promise for caller to await if needed
    }

    if (parsedQuery.loadBasic) {
        const needsRun = needsAutoboot === "run";
        needsAutoboot = "";

        await insertBasic(
            (async () => {
                const data = await utils.loadData(parsedQuery.loadBasic);
                return String.fromCharCode.apply(null, data);
            })(),
            needsRun,
        );
    }

    if (parsedQuery.embedBasic) {
        await insertBasic(Promise.resolve(parsedQuery.embedBasic), true);
    }

    return Promise.all(imageLoads);
})();

(async () => {
    try {
        await startPromise;

        switch (needsAutoboot) {
            case "boot":
                sthAutoboot.checked = true;
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
                sthAutoboot.checked = false;
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
    aysEl.querySelector(".context").textContent = message;
    aysEl.querySelector(".ays-yes").textContent = yesText;
    aysEl.querySelector(".ays-no").textContent = noText;
    aysEl.querySelector(".ays-yes").addEventListener(
        "click",
        function () {
            aysModal.hide();
            yesFunc();
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
            if (this.cycles >= 10 * 2 * 1000 * 1000) {
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
