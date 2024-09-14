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
import { starCat } from "./discs/cat.js";
import { loadTape, loadTapeFromData } from "./tapes.js";
import { GoogleDriveLoader } from "./google-drive.js";
import * as tokeniser from "./basic-tokenise.js";
import * as canvasLib from "./canvas.js";
import { Config } from "./config.js";
import { initialise as electron } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { Econet } from "./econet.js";
import { toSsdOrDsd } from "./disc.js";

let processor;
let video;
let dbgr;
let frames = 0;
let frameSkip = 0;
let syncLights;
let discSth;
let tapeSth;
let running;
let model;
const gamepad = new GamePad();
let availableImages;
let discImage;
const extraRoms = [];
if (typeof starCat === "function") {
    availableImages = starCat();

    if (availableImages && availableImages[0]) {
        discImage = availableImages[0].file;
    }
}
let queryString = document.location.search.substring(1) + "&" + window.location.hash.substring(1);
let secondDiscImage = null;
let parsedQuery = {};
let needsAutoboot = false;
let autoType = "";
let keyLayout = window.localStorage.keyLayout || "physical";

const BBC = utils.BBC;
const keyCodes = utils.keyCodes;
const emuKeyHandlers = {};
let cpuMultiplier = 1;
let fastAsPossible = false;
let fastTape = false;
let noSeek = false;
let pauseEmu = false;
let stepEmuWhenPaused = false;
let audioFilterFreq = 7000;
let audioFilterQ = 5;
let stationId = 101;
let econet = null;
const isMac = window.navigator.platform.indexOf("Mac") === 0;

if (queryString) {
    if (queryString[queryString.length - 1] === "/")
        // workaround for shonky python web server
        queryString = queryString.substring(0, queryString.length - 1);
    queryString.split("&").forEach(function (keyval) {
        const keyAndVal = keyval.split("=");
        const key = decodeURIComponent(keyAndVal[0]);
        let val = null;
        if (keyAndVal.length > 1) val = decodeURIComponent(keyAndVal[1]);
        parsedQuery[key] = val;

        // eg KEY.CAPSLOCK=CTRL
        let bbcKey;
        if (key.toUpperCase().indexOf("KEY.") === 0) {
            bbcKey = val.toUpperCase();

            if (BBC[bbcKey]) {
                const nativeKey = key.substring(4).toUpperCase(); // remove KEY.
                if (keyCodes[nativeKey]) {
                    console.log("mapping " + nativeKey + " to " + bbcKey);
                    utils.userKeymap.push({ native: nativeKey, bbc: bbcKey });
                } else {
                    console.log("unknown key: " + nativeKey);
                }
            } else {
                console.log("unknown BBC key: " + val);
            }
        } else if (key.indexOf("GP.") === 0) {
            // gamepad mapping
            // eg ?GP.FIRE2=RETURN
            const gamepadKey = key.substring(3).toUpperCase(); // remove GP. prefix
            gamepad.remap(gamepadKey, val.toUpperCase());
        } else {
            switch (key) {
                case "LEFT":
                case "RIGHT":
                case "UP":
                case "DOWN":
                case "FIRE":
                    gamepad.remap(key, val.toUpperCase());
                    break;
                case "autoboot":
                    needsAutoboot = "boot";
                    break;
                case "autochain":
                    needsAutoboot = "chain";
                    break;
                case "autorun":
                    needsAutoboot = "run";
                    break;
                case "autotype":
                    needsAutoboot = "type";
                    autoType = val;
                    break;
                case "keyLayout":
                    keyLayout = (val + "").toLowerCase();
                    break;
                case "disc":
                case "disc1":
                    discImage = val;
                    break;
                case "rom":
                    extraRoms.push(val);
                    break;
                case "disc2":
                    secondDiscImage = val;
                    break;
                case "embed":
                    $(".embed-hide").hide();
                    $("body").css("background-color", "transparent");
                    break;
                case "fasttape":
                    fastTape = true;
                    break;
                case "noseek":
                    noSeek = true;
                    break;
                case "audiofilterfreq":
                    audioFilterFreq = Number(val);
                    break;
                case "audiofilterq":
                    audioFilterQ = Number(val);
                    break;
                case "stationId":
                    stationId = Number(val);
                    break;
            }
        }
    });
}

if (parsedQuery.frameSkip) frameSkip = parseInt(parsedQuery.frameSkip);

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
        processor.updateKeyLayout();
    }
});

// Perform mapping of legacy models to the new format
config.mapLegacyModels(parsedQuery);

config.setModel(parsedQuery.model || guessModelFromUrl());
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

if (parsedQuery.cpuMultiplier) {
    cpuMultiplier = parseFloat(parsedQuery.cpuMultiplier);
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

const audioHandler = new AudioHandler($("#audio-warning"), audioFilterFreq, audioFilterQ, noSeek);
// Firefox will report that audio is suspended even when it will
// start playing without user interaction, so we need to delay a
// little to get a reliable indication.
window.setTimeout(() => audioHandler.checkStatus(), 1000);

let lastShiftLocation = 1;
let lastCtrlLocation = 1;
let lastAltLocation = 1;

dbgr = new Debugger(video);

$(".initially-hidden").removeClass("initially-hidden");

function keyCode(evt) {
    const ret = evt.which || evt.charCode || evt.keyCode;

    const keyCodes = utils.keyCodes;

    switch (evt.location) {
        default:
            // keyUp events seem to pass location = 0 (Chrome)
            switch (ret) {
                case keyCodes.SHIFT:
                    if (lastShiftLocation === 1) {
                        return keyCodes.SHIFT_LEFT;
                    } else {
                        return keyCodes.SHIFT_RIGHT;
                    }

                case keyCodes.ALT:
                    if (lastAltLocation === 1) {
                        return keyCodes.ALT_LEFT;
                    } else {
                        return keyCodes.ALT_RIGHT;
                    }

                case keyCodes.CTRL:
                    if (lastCtrlLocation === 1) {
                        return keyCodes.CTRL_LEFT;
                    } else {
                        return keyCodes.CTRL_RIGHT;
                    }
            }
            break;
        case 1:
            switch (ret) {
                case keyCodes.SHIFT:
                    lastShiftLocation = 1;
                    return keyCodes.SHIFT_LEFT;

                case keyCodes.ALT:
                    lastAltLocation = 1;
                    return keyCodes.ALT_LEFT;

                case keyCodes.CTRL:
                    lastCtrlLocation = 1;
                    return keyCodes.CTRL_LEFT;
            }
            break;
        case 2:
            switch (ret) {
                case keyCodes.SHIFT:
                    lastShiftLocation = 2;
                    return keyCodes.SHIFT_RIGHT;

                case keyCodes.ALT:
                    lastAltLocation = 2;
                    return keyCodes.ALT_RIGHT;

                case keyCodes.CTRL:
                    lastCtrlLocation = 2;
                    return keyCodes.CTRL_RIGHT;
            }
            break;
        case 3: // numpad
            switch (ret) {
                case keyCodes.ENTER:
                    return utils.keyCodes.NUMPADENTER;

                case keyCodes.DELETE:
                    return utils.keyCodes.NUMPAD_DECIMAL_POINT;
            }
            break;
    }

    return ret;
}

function keyPress(evt) {
    if (document.activeElement.id === "paste-text") return;
    if (running || (!dbgr.enabled() && !pauseEmu)) return;
    const code = keyCode(evt);
    if (dbgr.enabled() && code === 103 /* lower case g */) {
        dbgr.hide();
        go();
        return;
    }
    if (pauseEmu) {
        if (code === 103 /* lower case g */) {
            pauseEmu = false;
            go();
            return;
        } else if (code === 110 /* lower case n */) {
            stepEmuWhenPaused = true;
            go();
            return;
        }
    }
    const handled = dbgr.keyPress(keyCode(evt));
    if (handled) evt.preventDefault();
}

emuKeyHandlers[utils.keyCodes.S] = function (down) {
    if (down) {
        utils.noteEvent("keyboard", "press", "S");
        stop(true);
    }
};
emuKeyHandlers[utils.keyCodes.R] = function (down) {
    if (down) window.location.reload();
};

function keyDown(evt) {
    audioHandler.tryResume();
    if (document.activeElement.id === "paste-text") return;
    if (!running) return;
    const code = keyCode(evt);
    if (evt.altKey) {
        const handler = emuKeyHandlers[code];
        if (handler) {
            handler(true, code);
            evt.preventDefault();
        }
    } else if (code === utils.keyCodes.HOME && evt.ctrlKey) {
        utils.noteEvent("keyboard", "press", "home");
        stop(true);
    } else if (code === utils.keyCodes.INSERT && evt.ctrlKey) {
        utils.noteEvent("keyboard", "press", "insert");
        fastAsPossible = !fastAsPossible;
    } else if (code === utils.keyCodes.END && evt.ctrlKey) {
        utils.noteEvent("keyboard", "press", "end");
        pauseEmu = true;
        stop(false);
    } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
        utils.noteEvent("keyboard", "press", "break");
        processor.setReset(true);
        evt.preventDefault();
    } else if (code === utils.keyCodes.B && evt.ctrlKey) {
        // Ctrl-B turns on the printer, so we open a printer output
        // window in addition to passing the keypress along to the beeb.
        processor.sysvia.keyDown(code, evt.shiftKey);
        evt.preventDefault();
        checkPrinterWindow();
    } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
        handleMacCapsLock();
        evt.preventDefault();
    } else {
        processor.sysvia.keyDown(code, evt.shiftKey);
        evt.preventDefault();
    }
}

function keyUp(evt) {
    if (document.activeElement.id === "paste-text") return;
    // Always let the key ups come through. That way we don't cause sticky keys in the debugger.
    const code = keyCode(evt);
    if (processor && processor.sysvia) processor.sysvia.keyUp(code);
    if (!running) return;
    if (evt.altKey) {
        const handler = emuKeyHandlers[code];
        if (handler) handler(false, code);
    } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
        processor.setReset(false);
    } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
        handleMacCapsLock();
    }
    evt.preventDefault();
}

function handleMacCapsLock() {
    // Mac browsers seem to model caps lock as a physical key that's down when capslock is on, and up when it's off.
    // No event is generated when it is physically released on the keyboard. So, we simulate a "tap" here.
    processor.sysvia.keyDown(utils.keyCodes.CAPSLOCK);
    setTimeout(() => processor.sysvia.keyUp(utils.keyCodes.CAPSLOCK), 100);
    if (!window.localStorage.getItem("warnedAboutRubbishMacs")) {
        showError(
            "handling caps lock on Mac OS X",
            "Mac OS X does not generate key up events for caps lock presses. " +
                "jsbeeb can only simulate a 'tap' of the caps lock key. This means it doesn't work well for games " +
                " that use caps lock for left or fire, as we can't tell if it's being held down. If you need to play " +
                "such a game, please see the documentation about remapping keys." +
                "Close this window to continue (you won't see this error again)",
        );
        window.localStorage.setItem("warnedAboutRubbishMacs", true);
    }
}

const $discsModal = new bootstrap.Modal(document.getElementById("discs"));
const $fsModal = new bootstrap.Modal(document.getElementById("econetfs"));

function loadHTMLFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        processor.fdc.loadDisc(0, disc.discFor(processor.fdc, file.name, e.target.result));
        delete parsedQuery.disc;
        delete parsedQuery.disc1;
        updateUrl();
        $discsModal.hide();
    };
    reader.readAsBinaryString(file);
}

function loadSCSIFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        processor.filestore.scsi = utils.stringToUint8Array(e.target.result);

        processor.filestore.PC = 0x400;
        processor.filestore.SP = 0xff;
        processor.filestore.A = 1;
        processor.filestore.emulationSpeed = 0;

        // Reset any open receive blocks
        processor.econet.receiveBlocks = [];
        processor.econet.nextReceiveBlockNumber = 1;

        $fsModal.hide();
    };
    reader.readAsBinaryString(file);
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
$pastetext.on("drop", function (event) {
    utils.noteEvent("local", "drop");
    const file = event.originalEvent.dataTransfer.files[0];
    loadHTMLFile(file);
});

const $cub = $("#cub-monitor");
$cub.on("mousemove mousedown mouseup", function (evt) {
    audioHandler.tryResume();
    if (document.activeElement !== document.body) document.activeElement.blur();
    const cubOffset = $cub.offset();
    const screenOffset = $screen.offset();
    const x = (evt.offsetX - cubOffset.left + screenOffset.left) / $screen.width();
    const y = (evt.offsetY - cubOffset.top + screenOffset.top) / $screen.height();
    if (processor.touchScreen) processor.touchScreen.onMouse(x, y, evt.buttons);
    evt.preventDefault();
});

$(window).blur(function () {
    if (processor.sysvia) processor.sysvia.clearKeys();
});

$("#fs").click(function (event) {
    $screen[0].requestFullscreen();
    event.preventDefault();
});

document.onkeydown = keyDown;
document.onkeypress = keyPress;
document.onkeyup = keyUp;

$("#debug-pause").click(() => stop(true));
$("#debug-play").click(() => {
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

function setDisc1Image(name) {
    delete parsedQuery.disc;
    parsedQuery.disc1 = name;
    updateUrl();
}

function sthClearList() {
    $("#sth-list li:not('.template')").remove();
}

function sthStartLoad() {
    $("#sth .loading").text("Loading catalog from STH archive");
    $("#sth .loading").show();
    sthClearList();
}

function discSthClick(item) {
    utils.noteEvent("sth", "click", item);
    setDisc1Image("sth:" + item);
    const needsAutoboot = parsedQuery.autoboot !== undefined;
    if (needsAutoboot) {
        processor.reset(true);
    }
    popupLoading("Loading " + item);
    loadDiscImage(parsedQuery.disc1)
        .then(function (disc) {
            processor.fdc.loadDisc(0, disc);
        })
        .then(
            function () {
                loadingFinished();
                if (needsAutoboot) {
                    autoboot(item);
                }
            },
            function (err) {
                loadingFinished(err);
            },
        );
}

function tapeSthClick(item) {
    utils.noteEvent("sth", "clickTape", item);
    parsedQuery.tape = "sth:" + item;
    updateUrl();
    popupLoading("Loading " + item);
    loadTapeImage(parsedQuery.tape).then(
        function () {
            loadingFinished();
        },
        function (err) {
            loadingFinished(err);
        },
    );
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
    $("#sth .loading").text("There was an error accessing the STH archive");
    $("#sth .loading").show();
    sthClearList();
}

discSth = new StairwayToHell(sthStartLoad, makeOnCat(discSthClick), sthOnError, false);
tapeSth = new StairwayToHell(sthStartLoad, makeOnCat(tapeSthClick), sthOnError, true);

$("#sth .autoboot").click(function () {
    if ($("#sth .autoboot").prop("checked")) {
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
    $("#sth-list li:not('.template')").each(function () {
        const el = $(this);
        el.toggle(el.text().toLowerCase().indexOf(filter) >= 0);
    });
}

$("#sth-filter").on("change keyup", function () {
    setSthFilter($("#sth-filter").val());
});

function sendRawKeyboardToBBC(keysToSend, checkCapsAndShiftLocks) {
    let lastChar;
    let nextKeyMillis = 0;
    processor.sysvia.disableKeyboard();

    if (checkCapsAndShiftLocks) {
        let toggleKey = null;
        if (!processor.sysvia.capsLockLight) toggleKey = BBC.CAPSLOCK;
        else if (processor.sysvia.shiftLockLight) toggleKey = BBC.SHIFTLOCK;
        if (toggleKey) {
            keysToSend.unshift(toggleKey);
            keysToSend.push(toggleKey);
        }
    }

    const sendCharHook = processor.debugInstruction.add(function nextCharHook() {
        const millis = processor.cycleSeconds * 1000 + processor.currentCycles / (clocksPerSecond / 1000);
        if (millis < nextKeyMillis) {
            return;
        }

        if (lastChar && lastChar !== utils.BBC.SHIFT) {
            processor.sysvia.keyToggleRaw(lastChar);
        }

        if (keysToSend.length === 0) {
            // Finished
            processor.sysvia.enableKeyboard();
            sendCharHook.remove();
            return;
        }

        const ch = keysToSend[0];
        const debounce = lastChar === ch;
        lastChar = ch;
        if (debounce) {
            lastChar = undefined;
            nextKeyMillis = millis + 30;
            return;
        }

        let time = 50;
        if (typeof lastChar === "number") {
            time = lastChar;
            lastChar = undefined;
        } else {
            processor.sysvia.keyToggleRaw(lastChar);
        }

        // remove first character
        keysToSend.shift();

        nextKeyMillis = millis + time;
    });
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
    let url = window.location.origin + window.location.pathname;
    let sep = "?";
    $.each(parsedQuery, function (key, value) {
        if (key.length > 0 && value) {
            url += sep + encodeURIComponent(key) + "=" + encodeURIComponent(value);
            sep = "&";
        }
    });
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

function loadDiscImage(discImage) {
    if (!discImage) return Promise.resolve(null);
    const split = splitImage(discImage);
    discImage = split.image;
    const schema = split.schema;
    if (schema[0] === "!" || schema === "local") {
        return Promise.resolve(disc.localDisc(processor.fdc, discImage));
    }
    // TODO: come up with a decent UX for passing an 'onChange' parameter to each of these.
    // Consider:
    // * hashing contents and making a local disc image named by original disc hash, save by that, and offer
    //   to load the modified disc on load.
    // * popping up a message that notes the disc has changed, and offers a way to make a local image
    // * Dialog box (ugh) saying "is this ok?"
    if (schema === "|" || schema === "sth") {
        return discSth.fetch(discImage).then(function (discData) {
            return disc.discFor(processor.fdc, discImage, discData);
        });
    }
    if (schema === "gd") {
        const splat = discImage.match(/([^/]+)\/?(.*)/);
        let title = "(unknown)";
        if (splat) {
            discImage = splat[1];
            title = splat[2];
        }
        return gdLoad({ title: title, id: discImage });
    }
    if (schema === "b64data") {
        const ssdData = atob(discImage);
        discImage = "disk.ssd";
        return Promise.resolve(disc.discFor(processor.fdc, discImage, ssdData));
    }
    if (schema === "data") {
        const arr = Array.prototype.map.call(atob(discImage), (x) => x.charCodeAt(0));
        const unzipped = utils.unzipDiscImage(arr);
        const discData = unzipped.data;
        discImage = unzipped.name;
        return Promise.resolve(disc.discFor(processor.fdc, discImage, discData));
    }
    if (schema === "http" || schema === "https" || schema === "file") {
        return utils.loadData(schema + "://" + discImage).then(function (discData) {
            if (/\.zip/i.test(discImage)) {
                const unzipped = utils.unzipDiscImage(discData);
                discData = unzipped.data;
                discImage = unzipped.name;
            }
            return disc.discFor(processor.fdc, discImage, discData);
        });
    }

    return disc.load("discs/" + discImage).then(function (discData) {
        return disc.discFor(processor.fdc, discImage, discData);
    });
}

function loadTapeImage(tapeImage) {
    const split = splitImage(tapeImage);
    tapeImage = split.image;
    const schema = split.schema;

    if (schema === "|" || schema === "sth") {
        return tapeSth.fetch(tapeImage).then(function (image) {
            processor.acia.setTape(loadTapeFromData(tapeImage, image));
        });
    }
    if (schema === "data") {
        const arr = Array.prototype.map.call(atob(tapeImage), (x) => x.charCodeAt(0));
        const unzipped = utils.unzipDiscImage(arr);
        return Promise.resolve(processor.acia.setTape(loadTapeFromData(unzipped.name, unzipped.data)));
    }

    if (schema === "http" || schema === "https") {
        return utils.loadData(schema + "://" + tapeImage).then(function (tapeData) {
            if (/\.zip/i.test(tapeImage)) {
                const unzipped = utils.unzipDiscImage(tapeData);
                tapeData = unzipped.data;
                tapeImage = unzipped.name;
            }
            processor.acia.setTape(loadTapeFromData(tapeImage, tapeData));
        });
    }

    return loadTape("tapes/" + tapeImage).then(function (tape) {
        processor.acia.setTape(tape);
    });
}

$("#disc_load").on("change", function (evt) {
    if (evt.target.files.length === 0) return;
    utils.noteEvent("local", "click"); // NB no filename here
    const file = evt.target.files[0];
    loadHTMLFile(file);
    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

$("#fs_load").on("change", function (evt) {
    if (evt.target.files.length === 0) return;
    utils.noteEvent("local", "click"); // NB no filename here
    const file = evt.target.files[0];
    loadSCSIFile(file);
    evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
});

$("#tape_load").on("change", function (evt) {
    if (evt.target.files.length === 0) return;
    const file = evt.target.files[0];
    const reader = new FileReader();
    utils.noteEvent("local", "clickTape"); // NB no filename here
    reader.onload = function (e) {
        processor.acia.setTape(loadTapeFromData("local file", e.target.result));
        delete parsedQuery.tape;
        updateUrl();
        $("#tapes").modal("hide");
    };
    reader.readAsBinaryString(file);
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

let gdAuthed = false;
const googleDrive = new GoogleDriveLoader();

function gdAuth(imm) {
    return googleDrive.authorize(imm).then(
        function (authed) {
            gdAuthed = authed;
            console.log("authed =", authed);
            return authed;
        },
        function (err) {
            console.log("Error handling google auth: " + err);
            $googleDrive.find(".loading").text("There was an error accessing your Google Drive account: " + err);
        },
    );
}

let googleDriveLoadingResolve, googleDriveLoadingReject;
$("#google-drive-auth form").on("submit", function (e) {
    $("#google-drive-auth").hide();
    e.preventDefault();
    gdAuth(false).then(function (authed) {
        if (authed) googleDriveLoadingResolve();
        else googleDriveLoadingReject(new Error("Unable to authorize Google Drive"));
    });
});

function gdLoad(cat) {
    // TODO: have a onclose flush event, handle errors
    /*
     $(window).bind("beforeunload", function() {
     return confirm("Do you really want to close?");
     });
     */
    popupLoading("Loading '" + cat.title + "' from Google Drive");
    return googleDrive
        .initialise()
        .then(function (available) {
            console.log("Google Drive available =", available);
            if (!available) throw new Error("Google Drive is not available");
            return gdAuth(true);
        })
        .then(function (authed) {
            console.log("Google Drive authed=", authed);
            if (authed) {
                return true;
            } else {
                return new Promise(function (resolve, reject) {
                    googleDriveLoadingResolve = resolve;
                    googleDriveLoadingReject = reject;
                    $("#google-drive-auth").show();
                });
            }
        })
        .then(function () {
            return googleDrive.load(processor.fdc, cat.id);
        })
        .then(function (ssd) {
            console.log("Google Drive loading finished");
            loadingFinished();
            return ssd;
        })
        .catch(function (error) {
            console.log("Google Drive loading error:", error);
            loadingFinished(error);
        });
}

$(".if-drive-available").hide();
googleDrive.initialise().then(function (available) {
    if (available) {
        $(".if-drive-available").show();
        gdAuth(true);
    }
});
const $googleDrive = $("#google-drive");
const $googleDriveModal = new bootstrap.Modal($googleDrive[0]);
$("#open-drive-link").on("click", function () {
    if (gdAuthed) {
        $googleDriveModal.show();
    } else {
        gdAuth(false).then(function (authed) {
            if (authed) {
                $googleDriveModal.hide();
            }
        });
    }
    return false;
});
$googleDrive[0].addEventListener("show.bs.modal", function () {
    $googleDrive.find(".loading").text("Loading...").show();
    $googleDrive.find("li").not(".template").remove();
    googleDrive.cat().then(function (cat) {
        const dbList = $googleDrive.find(".list");
        $googleDrive.find(".loading").hide();
        const template = dbList.find(".template");
        $.each(cat, function (_, cat) {
            const row = template.clone().removeClass("template").appendTo(dbList);
            row.find(".name").text(cat.title);
            $(row).on("click", function () {
                utils.noteEvent("google-drive", "click", cat.title);
                setDisc1Image("gd:" + cat.id + "/" + cat.title);
                gdLoad(cat).then(function (ssd) {
                    processor.fdc.loadDisc(0, ssd);
                });
                $googleDriveModal.hide();
            });
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

$("#google-drive form").on("submit", function (e) {
    e.preventDefault();
    const text = $("#google-drive .disc-name").val();
    if (!text) return;
    popupLoading("Connecting to Google Drive");
    $googleDriveModal.hide();
    popupLoading("Creating '" + text + "' on Google Drive");
    googleDrive.create(processor.fdc, text).then(
        function (result) {
            setDisc1Image("gd:" + result.fileId + "/" + text);
            processor.fdc.loadDisc(0, result.disc);
            loadingFinished();
        },
        function (error) {
            loadingFinished(error);
        },
    );
});

$("#download-drive-link").on("click", function () {
    const a = document.createElement("a");
    document.body.appendChild(a);
    a.style = "display: none";

    const disc = processor.fdc.drives[0].disc;
    const data = toSsdOrDsd(disc);
    let name = processor.fdc.drives[0].disc.name;
    name = name.substring(0, name.lastIndexOf(".")) + (disc.isDoubleSided ? ".dsd" : ".ssd");

    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = window.URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    window.URL.revokeObjectURL(url);
});

$("#download-filestore-link").on("click", function () {
    const a = document.createElement("a");
    document.body.appendChild(a);
    a.style = "display: none";

    const blob = new Blob([processor.filestore.scsi], { type: "application/octet-stream" }),
        url = window.URL.createObjectURL(blob);
    a.href = url;
    a.download = "scsi.dat";
    a.click();
    window.URL.revokeObjectURL(url);
});

$("#hard-reset").click(function (event) {
    processor.reset(true);
    event.preventDefault();
});

$("#soft-reset").click(function (event) {
    processor.reset(false);
    event.preventDefault();
});

function guessModelFromUrl() {
    if (window.location.hostname.indexOf("bbc") === 0) return "B-DFS1.2";
    if (window.location.hostname.indexOf("master") === 0) return "Master";
    return "B-DFS1.2";
}

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

const startPromise = Promise.all([audioHandler.initialise(), processor.initialise()]).then(function () {
    // Ideally would start the loads first. But their completion needs the FDC from the processor
    const imageLoads = [];
    if (discImage)
        imageLoads.push(
            loadDiscImage(discImage).then(function (disc) {
                processor.fdc.loadDisc(0, disc);
            }),
        );
    if (secondDiscImage)
        imageLoads.push(
            loadDiscImage(secondDiscImage).then(function (disc) {
                processor.fdc.loadDisc(1, disc);
            }),
        );
    if (parsedQuery.tape) imageLoads.push(loadTapeImage(parsedQuery.tape));

    function insertBasic(getBasicPromise, needsRun) {
        imageLoads.push(
            getBasicPromise
                .then(function (prog) {
                    return tokeniser.create().then(function (t) {
                        return t.tokenise(prog);
                    });
                })
                .then(function (tokenised) {
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
                }),
        );
    }

    if (parsedQuery.loadBasic) {
        const needsRun = needsAutoboot === "run";
        needsAutoboot = "";
        insertBasic(
            new Promise(function (resolve) {
                utils.loadData(parsedQuery.loadBasic).then(function (data) {
                    resolve(String.fromCharCode.apply(null, data));
                });
            }),
            needsRun,
        );
    }

    if (parsedQuery.embedBasic) {
        insertBasic(
            new Promise(function (resolve) {
                resolve(parsedQuery.embedBasic);
            }),
            true,
        );
    }

    return Promise.all(imageLoads);
});

startPromise.then(
    function () {
        switch (needsAutoboot) {
            case "boot":
                $("#sth .autoboot").prop("checked", true);
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
                $("#sth .autoboot").prop("checked", false);
                break;
        }

        if (parsedQuery.patch) {
            dbgr.setPatch(parsedQuery.patch);
        }

        go();
    },
    function (error) {
        showError("initialising", error);
        console.log(error);
    },
);

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
    const frameSkipCount = speedy ? 9 : 0;
    video.frameSkipCount = frameSkipCount;

    // We use setTimeout instead of requestAnimationFrame in two cases:
    // a) We're trying to run as fast as possible.
    // b) Tape is playing, normal speed but backgrounded tab should run.
    if (useTimeout) {
        window.setTimeout(draw, timeout);
    } else {
        window.requestAnimationFrame(draw);
    }

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
        if (stepEmuWhenPaused) {
            stop(false);
            stepEmuWhenPaused = false;
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
    $("#debug-play").attr("disabled", running);
    $("#debug-pause").attr("disabled", !running);
}

function go() {
    audioHandler.unmute();
    running = true;
    updateDebugButtons();
    run();
}

function stop(debug) {
    running = false;
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
