import { version } from "../package.json";

import "bootswatch/dist/darkly/bootstrap.min.css";
import "./jsbeeb.css";

import * as utils from "./utils.js";
import { Debugger } from "./web/debug.js";
import * as utils_atom from "./utils_atom.js";
import { GamePad } from "./gamepads.js";
import { initialise as electron } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { installIcons } from "./web/icons.js";
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
import { RunControls } from "./web/run-controls.js";
import { exposeConsoleSurface } from "./web/console-surface.js";
import { KeyboardSetup } from "./web/keyboard-setup.js";
import { AccessibilitySwitches } from "./web/accessibility-switches.js";
import { AnalogueInputs } from "./web/analogue-inputs.js";
import { FrontPanel } from "./web/front-panel.js";
import { Machine } from "./web/machine.js";
import { Drives } from "./web/drives.js";
import { UrlState } from "./web/url-state.js";
import { Modals } from "./web/modals.js";
import { Settings } from "./web/settings.js";
import { Config } from "./web/config.js";
import { SpeechOutput } from "./speech-output.js";
import { Printer } from "./printer.js";
import { RewindBuffer } from "./rewind.js";
import { RewindUI } from "./web/rewind-ui.js";
import { DiscVisualiser } from "./web/disc-visualiser.js";
import { PageActions } from "./web/page-actions.js";
import { parseMediaParams, processAutobootParams, processDriveTrackParams, processInputParams } from "./url-params.js";

installIcons();

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
const defaultBootDisc = queryDiscImage ? undefined : discImage;
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

const tryGl = parsedQuery.glEnabled ?? true;
const lowLatency = parsedQuery.lowLatency ?? true;

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

const accessibilitySwitches = new AccessibilitySwitches();

const settings = new Settings({ urlState });
const { keyLayout, displayMode, audioOutput, speakerAmount } = settings;
const model = settings.model;
const config = new Config(settings);

const speechOutput = new SpeechOutput();
const speak = (enabled) => {
    speechOutput.enabled = enabled;
    if (enabled && typeof speechSynthesis === "undefined")
        toast("This browser has no speech synthesis, so speech output has nothing to speak with.", { title: "Speech" });
};
speak(settings.speechOutput);
settings.on("speechOutput", speak);

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
    hasMusic5000: settings.hasMusic5000,
});
// Firefox will report that audio is suspended even when it will
// start playing without user interaction, so we need to delay a
// little to get a reliable indication.
window.setTimeout(() => audioHandler.checkStatus(), 1000);

new QuickSettings(settings);

// ------------------------------------------------------------------------
// The machine, the loop that runs it, and everything that feeds it.
// ------------------------------------------------------------------------

// Depends on the settings having applied the URL parameters.
const machine = new Machine({
    model,
    settings,
    parsedQuery,
    keyLayout,
    cpuMultiplier,
    extraRoms,
    stationId,
    userPort: accessibilitySwitches.userPort,
    printer,
    speechOutput,
    video,
    audioHandler,
    dbgr,
});
const processor = machine.processor;

const { keyboard } = new KeyboardSetup({
    actions: {
        enterDebugger: () => loop.stop(true),
        reload: () => window.location.reload(),
        toggleFast: () => loop.toggleFastAsPossible(),
        openRewind: () => rewindUI.open(),
        openPrinter: () => frontPanel.checkPrinterWindow(),
        pause: () => loop.stop(false),
        resume: () => loop.go(),
        paste: (text) => keyboard.sendRawKeyboard(autoBoot.stringToMachineKeys(text), true),
        onAnyKeyDown: () => {
            audioHandler.tryResume();
            inputs.ensureMicrophoneRunning();
        },
    },
    accessibilitySwitches,
    processor,
    dbgr,
    keyLayout,
});

const rewindBuffer = new RewindBuffer(30);
const loop = new EmulationLoop({
    processor,
    display,
    audioHandler,
    dbgr,
    gamepad,
    keyboard,
    syncLights: () => frontPanel.syncLights(),
    rewindBuffer,
    onRewindCaptured: () => rewindUI.updateButtonState(),
    clocksPerSecond,
    cpuSpeed,
    fastTape: !!parsedQuery.fasttape,
    audioStatsNode,
});

const runControls = new RunControls({ loop, dbgr, keyboard });

const modals = new Modals({ loop });

const drives = new Drives({ fdc: processor.fdc, driveTracks, confirm: modals.confirm.bind(modals) });
const media = new MediaLoader({
    processor,
    model,
    drives,
    urlState,
    modals,
    isSnapshotFile,
    loadSnapshot: (file, buffer) => snapshots.loadStateFromFile(file, buffer),
});
const autoBoot = new Autoboot({
    model,
    processor,
    sendKeys: (keysToSend, check) => keyboard.sendRawKeyboard(keysToSend, check),
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
new HfePicker({
    media,
    drives,
    modals,
    urlState,
    processor,
    autoboot: (image) => autoBoot.boot(image),
});
new GoogleDrivePicker({ media, drives, modals, processor });
const snapshots = new SnapshotUI({
    processor,
    model,
    video,
    media,
    drives,
    urlState,
    modals,
    loop,
    defaultBootDisc,
});

const inputs = new AnalogueInputs({
    processor,
    screenCanvas,
    getGamepads: machine.emulationConfig.getGamepads,
    settings,
    audioHandler,
});
if (settings.microphoneChannel !== undefined) {
    // We need to use setTimeout to make sure this runs after the page has loaded
    // This is needed because some browsers require user interaction for audio context
    setTimeout(async () => {
        await inputs.setupMicrophone();
    }, 1000);
}
// Apply ADC source settings from URL parameters
inputs.updateAdcSources(settings.mouseJoystickEnabled, settings.microphoneChannel);

const frontPanel = new FrontPanel({ processor, model, printer });

// ------------------------------------------------------------------------
// Rewind, the visualiser and the layout.
// ------------------------------------------------------------------------

const rewindUI = new RewindUI({
    rewindBuffer,
    processor,
    video,
    captureInterval: RewindCaptureInterval,
    loop,
});
rewindUI.updateButtonState();

new DiscVisualiser({ fdc: processor.fdc });

const layout = new Layout({
    screenCanvas,
    display,
    embed: !!parsedQuery.embed,
    sidebars: { left: parsedQuery.sbLeft, right: parsedQuery.sbRight, bottom: parsedQuery.sbBottom },
});

// Everything a setting can reach now exists.
settings.on("audioOutput", (output) => audioHandler.setAudioOutput(output));
settings.on("speakerAmount", (amount) => audioHandler.setSpeakerAmount(amount));
settings.on("displayMode", (mode) => {
    display.setMode(mode);
    // The monitor picture may have changed shape.
    layout.resize();
});
settings.on("keyLayout", (chosen) => {
    keyboard.setKeyLayout(chosen);
    // A reset reads the layout from the machine's config again.
    machine.emulationConfig.keyLayout = chosen;
});
settings.on("tubeCpuMultiplier", (multiplier) => {
    if (processor.hasTube) processor.tube.cpuMultiplier = multiplier;
});
const rerouteAnalogue = () => inputs.updateAdcSources(settings.mouseJoystickEnabled, settings.microphoneChannel);
settings.on("mouseJoystickEnabled", rerouteAnalogue);
settings.on("microphoneChannel", (channel) => {
    rerouteAnalogue();
    if (channel !== undefined) inputs.setupMicrophone();
});
config.addEventListener("restart-required", async () => {
    const restart = await modals.confirm(
        "Your change is saved, but only takes effect when the emulator restarts. Restart now?",
        "Restart now",
        "Later",
    );
    if (restart) window.location.reload();
});

const page = new PageActions({ loop, processor, keyboard, audioHandler, rewindUI, modals, parsedQuery, version });

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

exposeConsoleSurface(window, { loop, processor, video, audioHandler });

// Hooks for electron.
electron({
    loadDiscImage: media.loadDiscImage.bind(media),
    loadTapeImage: media.loadTapeImage.bind(media),
    processor,
    settings,
    media,
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
        "soft-reset": () => page.softReset(),
        "hard-reset": () => page.hardReset(),
        "save-state": () => snapshots.saveState(),
        rewind: () => rewindUI.open(),
        pause: () => runControls.pause(),
        resume: () => runControls.resume(),
    },
});
