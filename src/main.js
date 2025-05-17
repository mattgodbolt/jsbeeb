import $ from "jquery";
import _ from "underscore";
import * as bootstrap from "bootstrap";

import "bootswatch/dist/darkly/bootstrap.min.css";
import "./jsbeeb.css";

import * as utils from "./utils.js";
import { FakeVideo, Video } from "./video.js";
import { Debugger } from "./web/debug.js";
import { Cpu6502 } from "./6502.js";
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
const dbgr = new Debugger();
let frames = 0;
let frameSkip = 0;
let syncLights;
let discSth;
let tapeSth;
let running;
let model;
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

    // Numeric parameters
    speed: ParamTypes.INT,
    stationId: ParamTypes.INT,
    frameSkip: ParamTypes.INT,
    audiofilterfreq: ParamTypes.FLOAT,
    audiofilterq: ParamTypes.FLOAT,
    cpuMultiplier: ParamTypes.FLOAT,

    // String parameters (these are the default but listed for clarity)
    model: ParamTypes.STRING,
    disc: ParamTypes.STRING,
    disc1: ParamTypes.STRING,
    disc2: ParamTypes.STRING,
    tape: ParamTypes.STRING,
    keyLayout: ParamTypes.STRING,
    autotype: ParamTypes.STRING,
};

// Parse the query string with parameter types
let parsedQuery = parseQueryString(queryString, paramTypes);
let { needsAutoboot, autoType } = processAutobootParams(parsedQuery);
let keyLayout = window.localStorage.keyLayout || "physical";

const BBC = utils.BBC;
const keyCodes = utils.keyCodes;
const emuKeyHandlers = {};
let cpuMultiplier = 1;
let fastAsPossible = false;
let fastTape = false;
let noSeek = false;
let audioFilterFreq = 7000;
let audioFilterQ = 5;
let stationId = 101;
let econet = null;

// Parse disc and tape images from query parameters
const { discImage: queryDiscImage, secondDiscImage: querySecondDisc } = parseMediaParams(parsedQuery);

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
    $(".embed-hide").hide();
    $("body").css("background-color", "transparent");
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

let userPort = null;

const keyswitch = true;
if (keyswitch) {
    let switchState = 0xff;

    const switchKey = function (down, code) {
        const bit = 1 << (code - utils.keyCodes.K1);
        if (down) switchState &= 0xff ^ bit;
        else switchState |= bit;
    };

    for (let idx = utils.keyCodes.K1; idx <= utils.keyCodes.K8; ++idx) {
        emuKeyHandlers[idx] = switchKey;
    }
    userPort = {
        write: function () {},
        read: function () {
            return switchState;
        },
    };
}

const emulationConfig = {
    keyLayout: keyLayout,
    coProcessor: parsedQuery.coProcessor,
    cpuMultiplier: cpuMultiplier,
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

const config = new Config(function (changed) {
    parsedQuery = _.extend(parsedQuery, changed);
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
});

// Perform mapping of legacy models to the new format
config.mapLegacyModels(parsedQuery);

config.setModel(parsedQuery.model || guessModelFromHostname(window.location.hostname));
config.setKeyLayout(keyLayout);
config.set65c02(parsedQuery.coProcessor);
config.setEconet(parsedQuery.hasEconet);
config.setMusic5000(parsedQuery.hasMusic5000);
config.setTeletext(parsedQuery.hasTeletextAdaptor);

model = config.model;

function sbBind(div, url, onload) {
    const img = div.find("img");
    img.hide();
    if (!url) return;
    img.attr("src", url).bind("load", function () {
        onload(div, img);
        img.show();
    });
}

sbBind($(".sidebar.left"), parsedQuery.sbLeft, function (div, img) {
    div.css({ left: -img.width() - 5 });
});
sbBind($(".sidebar.right"), parsedQuery.sbRight, function (div, img) {
    div.css({ right: -img.width() - 5 });
});
sbBind($(".sidebar.bottom"), parsedQuery.sbBottom, function (div, img) {
    div.css({ bottom: -img.height() });
});

if (parsedQuery.cpuMultiplier !== undefined) {
    cpuMultiplier = parsedQuery.cpuMultiplier;
    console.log("CPU multiplier set to " + cpuMultiplier);
}
const clocksPerSecond = (cpuMultiplier * 2 * 1000 * 1000) | 0;
const MaxCyclesPerFrame = clocksPerSecond / 10;

let tryGl = true;
if (parsedQuery.glEnabled !== undefined) {
    tryGl = parsedQuery.glEnabled === "true";
}
const $screen = $("#screen");
const canvas = tryGl ? canvasLib.bestCanvas($screen[0]) : new canvasLib.Canvas($screen[0]);
video = new Video(model.isMaster, canvas.fb32, function paint(minx, miny, maxx, maxy) {
    frames++;
    if (frames < frameSkip) return;
    frames = 0;
    canvas.paint(minx, miny, maxx, maxy);
});
if (parsedQuery.fakeVideo !== undefined) video = new FakeVideo();

const audioStatsNode = document.getElementById("audio-stats");
const audioHandler = new AudioHandler($("#audio-warning"), audioStatsNode, audioFilterFreq, audioFilterQ, noSeek);
if (!parsedQuery.audioDebug) audioStatsNode.style.display = "none";
// Firefox will report that audio is suspended even when it will
// start playing without user interaction, so we need to delay a
// little to get a reliable indication.
window.setTimeout(() => audioHandler.checkStatus(), 1000);

$(".initially-hidden").removeClass("initially-hidden");

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
    const binaryData = await readFileAsBinaryString(file);
    processor.fdc.loadDisc(0, disc.discFor(processor.fdc, file.name, binaryData));
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

const $pastetext = $("#paste-text");
$pastetext.on("paste", function (event) {
    const text = event.originalEvent.clipboardData.getData("text/plain");
    sendRawKeyboardToBBC(utils.stringToBBCKeys(text), true);
});
$pastetext.on("dragover", function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.originalEvent.dataTransfer.dropEffect = "copy";
});
$pastetext.on("drop", async function (event) {
    utils.noteEvent("local", "drop");
    const file = event.originalEvent.dataTransfer.files[0];
    await loadHTMLFile(file);
});

const $cub = $("#cub-monitor");
$cub.on("mousemove mousedown mouseup", function (evt) {
    audioHandler.tryResume().then(() => {});
    if (document.activeElement !== document.body) document.activeElement.blur();
    const cubOffset = $cub.offset();
    const screenOffset = $screen.offset();
    const x = (evt.offsetX - cubOffset.left + screenOffset.left) / $screen.width();
    const y = (evt.offsetY - cubOffset.top + screenOffset.top) / $screen.height();
    if (processor.touchScreen) processor.touchScreen.onMouse(x, y, evt.buttons);
    evt.preventDefault();
});

$(window).blur(function () {
    keyboard.clearKeys();
});

$("#fs").click(function (event) {
    $screen[0].requestFullscreen();
    event.preventDefault();
});

let keyboard; // This will be initialized after the processor is created

const $debugPause = $("#debug-pause");
const $debugPlay = $("#debug-play");
$debugPause.click(() => stop(true));
$debugPlay.click(() => {
    dbgr.hide();
    go();
});

// To lower chance of data loss, only accept drop events in the drop
// zone in the menu bar.
document.ondragover = function (event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
};
document.ondrop = function (event) {
    event.preventDefault();
};

window.onbeforeunload = function () {
    if (running && processor.sysvia.hasAnyKeyDown()) {
        return (
            "It seems like you're still using the emulator. If you're in Chrome, it's impossible for jsbeeb to prevent some shortcuts (like ctrl-W) from performing their default behaviour (e.g. closing the window).\n" +
            "As a workarond, create an 'Application Shortcut' from the Tools menu.  When jsbeeb runs as an application, it *can* prevent ctrl-W from closing the window."
        );
    }
};

if (model.hasEconet) {
    econet = new Econet(stationId);
} else {
    $("#fsmenuitem").hide();
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

processor = new Cpu6502(
    model,
    dbgr,
    video,
    audioHandler.soundChip,
    audioHandler.ddNoise,
    model.hasMusic5000 ? audioHandler.music5000 : null,
    cmos,
    emulationConfig,
    econet,
);

// Initialize keyboard now that processor exists
keyboard = new Keyboard({
    processor,
    inputEnabledFunction: () => document.activeElement && document.activeElement.id === "paste-text",
    keyLayout,
    dbgr,
});
keyboard.on("showError", ({ context, error }) => showError(context, error));
keyboard.on("pause", () => stop(false));
keyboard.on("resume", () => go());
keyboard.on("break", (pressed) => {
    // F12/Break: Reset processor
    if (pressed) utils.noteEvent("keyboard", "press", "break");
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
    utils.keyCodes.B,
    (down) => {
        if (down) {
            checkPrinterWindow();
        }
    },
    { alt: false, ctrl: true },
);

// Setup key handlers
document.onkeydown = (evt) => {
    audioHandler.tryResume();
    keyboard.keyDown(evt);
};
document.onkeypress = (evt) => keyboard.keyPress(evt);
document.onkeyup = (evt) => keyboard.keyUp(evt);

function setDisc1Image(name) {
    delete parsedQuery.disc;
    parsedQuery.disc1 = name;
    updateUrl();
}

function sthClearList() {
    $("#sth-list li:not(.template)").remove();
}

function sthStartLoad() {
    const $sth = $("#sth .loading");
    $sth.text("Loading catalog from STH archive");
    $sth.show();
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
    parsedQuery.tape = "sth:" + item;
    updateUrl();

    popupLoading("Loading " + item);
    try {
        const tape = await loadTapeImage(parsedQuery.tape);
        processor.acia.setTape(tape);
        loadingFinished();
    } catch (err) {
        console.error("Error loading tape image:", err);
        loadingFinished(err);
    }
}

const $sthModal = new bootstrap.Modal(document.getElementById("sth"));

function makeOnCat(onClick) {
    return function (cat) {
        sthClearList();
        const sthList = $("#sth-list");
        $("#sth .loading").hide();
        const template = sthList.find(".template");

        function doSome(all) {
            const MaxAtATime = 100;
            const Delay = 30;
            const cat = all.slice(0, MaxAtATime);
            const remaining = all.slice(MaxAtATime);
            const filter = $("#sth-filter").val();
            $.each(cat, function (_, cat) {
                const row = template.clone().removeClass("template").appendTo(sthList);
                row.find(".name").text(cat);
                $(row).on("click", function () {
                    onClick(cat);
                    $sthModal.hide();
                });
                row.toggle(cat.toLowerCase().indexOf(filter) >= 0);
            });
            if (all.length) _.delay(doSome, Delay, remaining);
        }

        doSome(cat);
    };
}

function sthOnError() {
    const $sthLoading = $("#sth .loading");
    $sthLoading.text("There was an error accessing the STH archive");
    $sthLoading.show();
    sthClearList();
}

discSth = new StairwayToHell(sthStartLoad, makeOnCat(discSthClick), sthOnError, false);
tapeSth = new StairwayToHell(sthStartLoad, makeOnCat(tapeSthClick), sthOnError, true);

const $sthAutoboot = $("#sth .autoboot");
$sthAutoboot.click(function () {
    if ($sthAutoboot.prop("checked")) {
        parsedQuery.autoboot = "";
    } else {
        delete parsedQuery.autoboot;
    }
    updateUrl();
});

$(document).on("click", "a.sth", function () {
    const type = $(this).data("id");
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
    $("#sth-list li:not(.template)").each(function () {
        const el = $(this);
        el.toggle(el.text().toLowerCase().indexOf(filter) >= 0);
    });
}

$("#sth-filter").on("change keyup", function () {
    setSthFilter($("#sth-filter").val());
});

function sendRawKeyboardToBBC(keysToSend, checkCapsAndShiftLocks) {
    if (keyboard) {
        keyboard.sendRawKeyboardToBBC(keysToSend, checkCapsAndShiftLocks);
    } else {
        console.warn("Tried to send keys before keyboard was initialized");
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

    const bbcKeys = utils.stringToBBCKeys(keys);
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
}

function autoChainTape() {
    console.log("Auto Chaining Tape");
    utils.noteEvent("init", "autochain");

    const bbcKeys = utils.stringToBBCKeys('*TAPE\nCH.""\n');
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
}

function autoRunTape() {
    console.log("Auto Running Tape");
    utils.noteEvent("init", "autorun");

    const bbcKeys = utils.stringToBBCKeys("*TAPE\n*/\n");
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
}

function autoRunBasic() {
    console.log("Auto Running basic");
    utils.noteEvent("init", "autorunbasic");

    const bbcKeys = utils.stringToBBCKeys("RUN\n");
    sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
}

function updateUrl() {
    const baseUrl = window.location.origin + window.location.pathname;
    const url = buildUrlFromParams(baseUrl, parsedQuery, paramTypes);
    window.history.pushState(null, null, url);
}

const $errorDialog = $("#error-dialog");
const $errorDialogModal = new bootstrap.Modal($errorDialog[0]);

function showError(context, error) {
    $errorDialog.find(".context").text(context);
    $errorDialog.find(".error").text(error);
    $errorDialogModal.show();
}

function splitImage(image) {
    const match = image.match(/(([^:]+):\/?\/?|[!^|])?(.*)/);
    const schema = match[2] || match[1] || "";
    image = match[3];
    return { image: image, schema: schema };
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
            const { name, data } = utils.unzipDiscImage(arr);
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
                const unzipped = utils.unzipDiscImage(discData);
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

    switch (schema) {
        case "|":
        case "sth":
            return loadTapeFromData(tapeImage, await tapeSth.fetch(tapeImage));

        case "data": {
            const arr = Array.prototype.map.call(atob(tapeImage), (x) => x.charCodeAt(0));
            const { name, data } = utils.unzipDiscImage(arr);
            return loadTapeFromData(name, data);
        }

        case "http":
        case "https": {
            const asUrl = `${schema}://${tapeImage}`;
            // url may end in query params etc, which can upset file handling
            tapeImage = new URL(asUrl).pathname;
            let tapeData = await utils.loadData(asUrl);
            if (/\.zip/i.test(tapeImage)) {
                const unzipped = utils.unzipDiscImage(tapeData);
                tapeData = unzipped.data;
                tapeImage = unzipped.name;
            }
            return loadTapeFromData(tapeImage, tapeData);
        }

        default:
            return await loadTape("tapes/" + tapeImage);
    }
}

$("#disc_load").on("change", async function (evt) {
    if (evt.target.files.length === 0) return;
    utils.noteEvent("local", "click"); // NB no filename here
    const file = evt.target.files[0];
    await loadHTMLFile(file);
    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

$("#fs_load").on("change", async function (evt) {
    if (evt.target.files.length === 0) return;
    utils.noteEvent("local", "click"); // NB no filename here
    const file = evt.target.files[0];
    await loadSCSIFile(file);
    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

$("#tape_load").on("change", async function (evt) {
    if (evt.target.files.length === 0) return;
    const file = evt.target.files[0];
    utils.noteEvent("local", "clickTape"); // NB no filename here

    const binaryData = await readFileAsBinaryString(file);
    processor.acia.setTape(loadTapeFromData("local file", binaryData));
    delete parsedQuery.tape;
    updateUrl();
    $("#tapes").modal("hide");

    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

function anyModalsVisible() {
    return $(".modal:visible").length !== 0;
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

const $loadingDialog = $("#loading-dialog");
const $loadingDialogModal = new bootstrap.Modal($loadingDialog[0]);

function popupLoading(msg) {
    $loadingDialog.find(".loading").text(msg);
    $("#google-drive-auth").hide();
    $loadingDialogModal.show();
}

function loadingFinished(error) {
    $("#google-drive-auth").hide();
    if (error) {
        $loadingDialogModal.show();
        $loadingDialog.find(".loading").text("Error: " + error);
        setTimeout(function () {
            $loadingDialogModal.hide();
        }, 5000);
    } else {
        $loadingDialogModal.hide();
    }
}

const googleDrive = new GoogleDriveLoader();

async function gdAuth(imm) {
    try {
        return await googleDrive.authorize(imm);
    } catch (err) {
        console.log("Error handling google auth: " + err);
        $googleDrive.find(".loading").text("There was an error accessing your Google Drive account: " + err);
    }
}

let googleDriveLoadingResolve, googleDriveLoadingReject;
$("#google-drive-auth form").on("submit", async function (e) {
    $("#google-drive-auth").hide();
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
                $("#google-drive-auth").show();
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

$(".if-drive-available").hide();
(async () => {
    const available = await googleDrive.initialise();
    if (available) {
        $(".if-drive-available").show();
        await gdAuth(true);
    }
})();
const $googleDrive = $("#google-drive");
const $googleDriveModal = new bootstrap.Modal($googleDrive[0]);
$("#open-drive-link").on("click", async function () {
    const authed = await gdAuth(false);
    if (authed) {
        $googleDriveModal.show();
    }
    return false;
});
$googleDrive[0].addEventListener("show.bs.modal", async function () {
    $googleDrive.find(".loading").text("Loading...").show();
    $googleDrive.find("li").not(".template").remove();
    const cat = await googleDrive.listFiles();
    const dbList = $googleDrive.find(".list");
    $googleDrive.find(".loading").hide();
    const template = dbList.find(".template");
    $.each(cat, function (_, cat) {
        const row = template.clone().removeClass("template").appendTo(dbList);
        row.find(".name").text(cat.name);
        $(row).on("click", function () {
            utils.noteEvent("google-drive", "click", cat.name);
            setDisc1Image(`gd:${cat.id}/${cat.name}`);
            gdLoad(cat).then(function (ssd) {
                processor.fdc.loadDisc(0, ssd);
            });
            $googleDriveModal.hide();
        });
    });
});
const discList = $("#disc-list");
const template = discList.find(".template");
$.each(availableImages, function (i, image) {
    const elem = template.clone().removeClass("template").appendTo(discList);
    elem.find(".name").text(image.name);
    elem.find(".description").text(image.desc);
    $(elem).on("click", function () {
        utils.noteEvent("images", "click", image.file);
        setDisc1Image(image.file);
        loadDiscImage(parsedQuery.disc1).then(function (disc) {
            processor.fdc.loadDisc(0, disc);
        });
        $discsModal.hide();
    });
});

$("#google-drive form").on("submit", async function (e) {
    e.preventDefault();
    let name = $("#google-drive .disc-name").val();
    if (!name) return;

    popupLoading("Connecting to Google Drive");
    $googleDriveModal.hide();
    popupLoading("Creating '" + name + "' on Google Drive");

    let data;
    if ($("#google-drive .create-from-existing").prop("checked")) {
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
        utils.setDiscName(data, name); // Will not work for non-SSD/DSD
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

$("#download-drive-link").on("click", function () {
    const disc = processor.fdc.drives[0].disc;
    const data = toSsdOrDsd(disc);
    const name = disc.name;
    const extension = disc.isDoubleSided ? ".dsd" : ".ssd";

    downloadDriveData(data, name, extension);
});

$("#download-drive-hfe-link").on("click", function () {
    const disc = processor.fdc.drives[0].disc;
    const data = toHfe(disc);
    const name = disc.name;

    downloadDriveData(data, name, ".hfe");
});

$("#download-filestore-link").on("click", function () {
    downloadDriveData(processor.filestore.scsi, "scsi", ".dat");
});

$("#hard-reset").click(function (event) {
    processor.reset(true);
    event.preventDefault();
});

$("#soft-reset").click(function (event) {
    processor.reset(false);
    event.preventDefault();
});

$("#tape-menu a").on("click", function (e) {
    const type = $(e.target).attr("data-id");
    if (type === undefined) return;

    if (type === "rewind") {
        console.log("Rewinding tape to the start");

        processor.acia.rewindTape();
    } else {
        console.log("unknown type", type);
    }
});

function Light(name) {
    const dom = $("#" + name);
    let on = false;
    this.update = function (val) {
        if (val === on) return;
        on = val;
        dom.toggleClass("on", on);
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
                processor.acia.setTape(tape);
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

startPromise
    .then(() => {
        switch (needsAutoboot) {
            case "boot":
                $sthAutoboot.prop("checked", true);
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
                $sthAutoboot.prop("checked", false);
                break;
        }

        if (parsedQuery.patch) {
            dbgr.setPatch(parsedQuery.patch);
        }

        go();
    })
    .catch((error) => {
        console.error("Error initializing emulator:", error);
        showError("initialising", error);
    });

const $ays = $("#are-you-sure");
const $aysModal = new bootstrap.Modal($ays[0]);

function areYouSure(message, yesText, noText, yesFunc) {
    $ays.find(".context").text(message);
    $ays.find(".ays-yes").text(yesText);
    $ays.find(".ays-no").text(noText);
    $ays.find(".ays-yes").one("click", function () {
        $aysModal.hide();
        yesFunc();
    });
    $aysModal.show();
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
    this.v = $(".virtualMHz");
    this.header = $("#virtual-mhz-header");
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
            this.v.text(thisMHz.toFixed(1));
            if (this.cycles >= 10 * 2 * 1000 * 1000) {
                this.cycles = this.time = 0;
            }
            this.header.css("color", this.speedy ? "red" : "white");
        }
        setTimeout(this.display.bind(this), 3333);
    };

    this.display();
}

const virtualSpeedUpdater = new VirtualSpeedUpdater();

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
    $debugPlay.attr("disabled", running);
    $debugPause.attr("disabled", !running);
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
    const $cubMonitor = $("#cub-monitor");
    const $cubMonitorPic = $("#cub-monitor-pic");
    const cubOrigHeight = $cubMonitorPic.attr("height");
    const cubOrigWidth = $cubMonitorPic.attr("width");
    const cubToScreenHeightRatio = $screen.attr("height") / cubOrigHeight;
    const cubToScreenWidthRatio = $screen.attr("width") / cubOrigWidth;
    const desiredAspectRatio = cubOrigWidth / cubOrigHeight;
    const minWidth = cubOrigWidth / 4;
    const minHeight = cubOrigHeight / 4;
    const borderReservedSize = parsedQuery.embed !== undefined ? 0 : 100;
    const bottomReservedSize = parsedQuery.embed !== undefined ? 0 : 68;

    function resizeTv() {
        let navbarHeight = $("#header-bar").outerHeight();
        let width = Math.max(minWidth, window.innerWidth - borderReservedSize * 2);
        let height = Math.max(minHeight, window.innerHeight - navbarHeight - bottomReservedSize);
        if (width / height <= desiredAspectRatio) {
            height = width / desiredAspectRatio;
        } else {
            width = height * desiredAspectRatio;
        }
        $cubMonitor.height(height).width(width);
        $cubMonitorPic.height(height).width(width);
        $screen.height(height * cubToScreenHeightRatio).width(width * cubToScreenWidthRatio);
    }

    window.onresize = resizeTv;
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
window.benchmarkCpu = _.debounce(benchmarkCpu, 1);
window.profileCpu = _.debounce(profileCpu, 1);
window.benchmarkVideo = _.debounce(benchmarkVideo, 1);
window.profileVideo = _.debounce(profileVideo, 1);
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
electron({ loadDiscImage, processor });
