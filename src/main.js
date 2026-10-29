import { version } from "../package.json";

import "bootswatch/dist/darkly/bootstrap.min.css";
import "./jsbeeb.css";

import { Debugger } from "./web/debug.js";
import { fillHelp, openHelpOnTheTabForNow } from "./web/help.js";
import { DebugMenu } from "./web/debug-menu.js";
import { PanelKeys } from "./web/panel-keys.js";
import { GamePad } from "./web/gamepads.js";
import { initialise as electron, isDesktopApp } from "./app/electron.js";
import { AudioHandler } from "./web/audio-handler.js";
import { installIcons } from "./web/icons.js";
import { QuickSettings } from "./web/quick-settings.js";
import { toast } from "./web/toast.js";
import { MediaLoader } from "./web/media-loader.js";
import { SthSource } from "./web/sth-source.js";
import { HfeSource } from "./web/hfe-source.js";
import { BitshiftersSource } from "./web/bitshifters-source.js";
import { GitHubSource } from "./web/github-source.js";
import { GoogleDriveSource } from "./web/google-drive-source.js";
import { isSnapshotFile, SnapshotUI } from "./web/snapshot-ui.js";
import { Autoboot } from "./web/autoboot.js";
import { Display } from "./web/display.js";
import { persistenceSettings } from "./web/canvas.js";
import { Layout } from "./web/layout.js";
import { EmulationLoop, RunMode } from "./web/emulation-loop.js";
import { RunControls } from "./web/run-controls.js";
import { exposeConsoleSurface } from "./web/console-surface.js";
import { KeyboardSetup } from "./web/keyboard-setup.js";
import { TouchKeyboard } from "./web/touch-keyboard.js";
import { labelPageShortcuts } from "./web/shortcuts.js";
import { AccessibilitySwitches } from "./web/accessibility-switches.js";
import { AnalogueInputs } from "./web/analogue-inputs.js";
import { FrontPanel } from "./web/front-panel.js";
import { Machine } from "./web/machine.js";
import { Drives } from "./web/drives.js";
import { UrlState } from "./web/url-state.js";
import { Modals } from "./web/modals.js";
import { Settings } from "./web/settings.js";
import { Config } from "./web/config.js";
import { SpeechOutput } from "./web/speech-output.js";
import { Printer } from "./printer.js";
import { DefaultStationId } from "./econet.js";
import { RewindUI } from "./web/rewind-ui.js";
import { DiscVisualiser } from "./web/disc-visualiser.js";
import { MediaWindow } from "./web/media-window.js";
import { PanelArrangement } from "./web/floating-panel.js";
import { SysViaPanel } from "./web/sysvia-panel.js";
import { CrtcPanel } from "./web/crtc-panel.js";
import { UserViaPanel } from "./web/uservia-panel.js";
import { VideoUlaPanel } from "./web/video-ula-panel.js";
import { BasicPanel } from "./web/basic-panel.js";
import { SoundChipPanel } from "./web/soundchip-panel.js";
import { FdcPanel } from "./web/fdc-panel.js";
import { cycleCount } from "./lockstep.js";
import { MachineSwitch } from "./web/machine-switch.js";
import { PageActions } from "./web/page-actions.js";
import { processDriveTrackParams } from "./url-params.js";
import { processInputParams, takenFromHostValues } from "./web/parameters.js";
import { hostKeyCodes, userKeymap } from "./keymap.js";
import { gzipCodec, hostSession, joinLink, sessionRefusal, startSessionFromUrl } from "./web/shared-session.js";
import { SessionDialog } from "./web/session-dialog.js";
import { sessionPage } from "./web/session-page.js";
import { webRtcTransport } from "./web/session-transport.js";
import { createRendezvousClient } from "./web/rendezvous-client.js";
import { SymbolSets } from "./symbol-sets.js";
import { LabelFiles } from "./label-files.js";
import { loadData } from "./loader.js";
import { configureAnalytics, noteError, noteFeature, noteMachineStart, silenceAnalytics } from "./web/analytics.js";
import { answerMissingVideoNula, VideoNulaFeature } from "./web/video-nula-notice.js";
import { BenchmarkPage } from "./web/benchmark-page.js";
import { hostAndRun, startAsTheUrlAsks, startupPlan } from "./web/startup.js";

const SymbolsBaseUrl = "https://bbc.xania.org/meta/symbols/";

// ------------------------------------------------------------------------
// What the URL asked for.
// ------------------------------------------------------------------------

const urlState = new UrlState(window.location, window.history);
const parsedQuery = urlState.params;

const benchmarkPage = parsedQuery.benchmark ? new BenchmarkPage(parsedQuery.benchmark) : null;
if (benchmarkPage) silenceAnalytics();
configureAnalytics();
installIcons();
fillHelp();
labelPageShortcuts();
const plan = startupPlan(parsedQuery);
const { settings: driveTracks, warnings: driveTrackWarnings } = processDriveTrackParams(parsedQuery);

const extraRoms = [];
if (Array.isArray(parsedQuery.rom)) {
    parsedQuery.rom.forEach((romPath) => {
        if (romPath) extraRoms.push(romPath);
    });
}

const cpuMultiplier = parsedQuery.cpuMultiplier ?? 1;
const noSeek = !!parsedQuery.noseek;
const stationId = parsedQuery.stationId ?? DefaultStationId;

const tryGl = parsedQuery.glEnabled ?? true;
const lowLatency = parsedQuery.lowLatency ?? true;

// ------------------------------------------------------------------------
// The pieces that exist before the machine: settings, screen, sound.
// ------------------------------------------------------------------------

const panelArrangement = new PanelArrangement(() => window.localStorage);
const panelKeys = new PanelKeys(panelArrangement);
const labelFiles = new LabelFiles({ load: loadData });
const dbgr = new Debugger({
    symbolSets: new SymbolSets({ baseUrl: new URL(SymbolsBaseUrl) }),
    labelFiles,
    keys: panelKeys,
    arrangement: panelArrangement,
    monitor: document.getElementById("cub-monitor"),
});

if (!window.isSecureContext)
    toast("Gamepads only work over https, so any joystick plugged in here is not seen.", {
        title: "Gamepads",
        quietKey: "quietInsecureGamepads",
    });

const printer = new Printer();

const accessibilitySwitches = new AccessibilitySwitches();

const settings = new Settings({ urlState });
const { keyLayout, displayMode, audioOutput, speakerAmount } = settings;
const { model, hasVideoNula } = settings;
const gamepad = new GamePad(model);
const takenFromHost = takenFromHostValues(settings, parsedQuery);
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
const bankRoms = [];
const labelFileUrls = [];
const familyWarnings = processInputParams(parsedQuery, {
    machineKeys: model.keys,
    hostKeyCodes,
    userKeymap,
    gamepad,
    bankRoms,
    labelFiles: labelFileUrls,
});
// One at a time, so that they are in the URL's order, which says whose name an address takes.
(async () => {
    for (const { url, bank } of labelFileUrls) {
        try {
            await labelFiles.load(url, bank);
        } catch (error) {
            toast(error.message, { title: "Label files" });
        }
    }
})();
if (familyWarnings.length) {
    toast(`${familyWarnings.join(" ")} The key names and ROM banks are listed in the README.`, {
        title: "Parameters in the URL",
    });
}
if (driveTrackWarnings.length) {
    toast(`${driveTrackWarnings.join(" ")} Auto is in use instead; pick 40 or 80 on the drive in the media window.`, {
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
    fakeVideo: !!parsedQuery.fakeVideo,
    hasVideoNula,
    onMissingVideoNula: answerMissingVideoNula({ inSession: () => !!loop.lockstep, settings }),
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
    bankRoms,
    stationId,
    userPort: accessibilitySwitches.userPort,
    printer,
    speechOutput,
    video,
    audioHandler,
    dbgr,
    gamepad,
});
const processor = machine.processor;
panelArrangement.followMachine(() => cycleCount(processor));

const loop = new EmulationLoop({
    processor,
    display,
    audioHandler,
    dbgr,
    gamepad,
    clocksPerSecond,
    cpuSpeed,
    fastTape: !!parsedQuery.fasttape,
    audioStatsNode,
});
dbgr.attachLoop(loop);

new RunControls({ loop });

const onAnyKeyDown = () => {
    audioHandler.tryResume();
    inputs.ensureMicrophoneRunning();
};
const { keyboard } = new KeyboardSetup({
    actions: {
        toggleFast: () => loop.toggleFastAsPossible(),
        openRewind: () => rewindUI.open(),
        openPrinter: () => frontPanel.checkPrinterWindow(),
        openMedia: (target) => mediaWindow.openFor(target),
        paste: (text) => keyboard.sendRawKeyboard(autoBoot.stringToMachineKeys(text), true),
        onAnyKeyDown,
    },
    accessibilitySwitches,
    processor,
    loop,
    dbgr,
    keys: panelKeys,
    keyLayout,
});

const modals = new Modals({ loop });
openHelpOnTheTabForNow(() => loop.isPaused() || loop.mode === RunMode.debugging);

const drives = new Drives({ fdc: processor.fdc, driveTracks, confirm: modals.confirm.bind(modals), urlState });
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
new SthSource({ media });
new HfeSource({ media });
new BitshiftersSource({ media });
new GitHubSource({ media });
const googleDriveSource = new GoogleDriveSource({ media });
const machineSwitch = new MachineSwitch({ model, processor, fitted: takenFromHost, urlState, modals });
const snapshots = new SnapshotUI({
    processor,
    model,
    video,
    media,
    urlState,
    modals,
    loop,
});

const inputs = new AnalogueInputs({
    processor,
    screenCanvas,
    getGamepads: machine.spec.getGamepads,
    settings,
    audioHandler,
    takeScreenClick: (x, y) => dbgr.showScreenByteAt(x, y),
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

const frontPanel = new FrontPanel({ processor, model, printer, loop });

// ------------------------------------------------------------------------
// Rewind, the visualiser and the layout.
// ------------------------------------------------------------------------

const rewindUI = new RewindUI({ processor, video, loop });
rewindUI.updateButtonState();

const discVisualiser = new DiscVisualiser({ fdc: processor.fdc, arrangement: panelArrangement });
const mediaWindow = new MediaWindow({
    media,
    drives,
    processor,
    model,
    loop,
    visualiser: discVisualiser,
    autoboot: () => autoBoot.boot(),
    driveSource: googleDriveSource,
    machineSwitch,
    arrangement: panelArrangement,
});

const layout = new Layout({
    screenCanvas,
    display,
    embed: !!parsedQuery.embed,
    sidebars: { left: parsedQuery.sbLeft, right: parsedQuery.sbRight, bottom: parsedQuery.sbBottom },
});
dbgr.placeBesideScreen(() => layout.screenBounds());
dbgr.keepOffTouchKeyboard(() => layout.touchKeyboardRoom !== null);
for (const DevicePanel of [SysViaPanel, UserViaPanel, CrtcPanel, SoundChipPanel, VideoUlaPanel])
    if (DevicePanel.fits(processor))
        new DevicePanel({ cpu: processor, arrangement: panelArrangement, audio: audioHandler });
new FdcPanel({ cpu: processor, arrangement: panelArrangement, visualiser: discVisualiser });
if (BasicPanel.fits(processor)) {
    new BasicPanel({
        cpu: processor,
        arrangement: panelArrangement,
        keys: panelKeys,
        runUntil: (stopsHere) => dbgr.runUntil(stopsHere),
        inDebugger: () => dbgr.inDebugger(),
    });
}
new DebugMenu({ arrangement: panelArrangement, dbgr });

if (!parsedQuery.embed && !model.isAtom) {
    new TouchKeyboard({
        processor,
        model,
        keyboard,
        layout,
        loop,
        forced: !!parsedQuery.touchkeys,
        openMedia: () => mediaWindow.openFor(0),
        onAnyKeyDown,
    });
}

panelArrangement.reopen();

// Everything a setting can reach now exists.
settings.on("audioOutput", (output) => audioHandler.setAudioOutput(output));
settings.on("speakerAmount", (amount) => audioHandler.setSpeakerAmount(amount));
settings.on("displayMode", (mode) => {
    display.setMode(mode);
    config.setPersistenceInUse(display.persistenceSetting());
    // The monitor picture may have changed shape.
    layout.resize();
});
config.setPersistenceInUse(display.persistenceSetting());
for (const { setting } of persistenceSettings()) {
    display.setPersistence(setting, settings[setting]);
    settings.on(setting, (persistence) => display.setPersistence(setting, persistence));
}
settings.on("keyLayout", (chosen) => keyboard.setKeyLayout(chosen));
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

// Described while the machine starts, so a switch to the machine the disc needs comes before the boot.
const bootDisc = plan.mayNeedAnotherModel ? media.describe(plan.media.discImage) : null;
const startPromise = machine.start({ media, autoBoot, ...plan.media });

(async () => {
    try {
        machineSwitch.announce();
        await startPromise;
        if (benchmarkPage) {
            const commit = import.meta.env.JSBEEB_COMMIT;
            await benchmarkPage.run({
                processor,
                display,
                audioHandler,
                slots: media.slots,
                loop,
                modals,
                parsedQuery,
                takenFromHost,
                commit,
                version,
            });
        } else {
            const started = await startAsTheUrlAsks(plan, {
                bootDisc,
                machineSwitch,
                drive0: media.slots.drive(0),
                renderer: display.canvas.renderer,
                noteStart: (details) => {
                    noteMachineStart(settings, parsedQuery, details, audioHandler.ready);
                    if (hasVideoNula) noteFeature(VideoNulaFeature, "fitted");
                },
                autoBoot,
                dbgr,
                snapshots,
                loop,
            });
            if (!started) return;
        }
        // A shared session's way in is the More menu, which the desktop app has removed by now.
        if (isDesktopApp()) return;
        const sessionContext = {
            processor,
            model,
            takenFromHost,
            loop,
            keyboard,
            version,
            transport: webRtcTransport(createRendezvousClient()),
            codec: gzipCodec,
            page: sessionPage(urlState, panelArrangement),
        };
        new SessionDialog({
            session: startSessionFromUrl(parsedQuery, sessionContext),
            refusal: sessionRefusal(sessionContext),
            host: hostAndRun(loop, (name) => hostSession(sessionContext, name)),
            join: (room, name) => window.location.assign(joinLink(room, name, urlState.params)),
        });
    } catch (error) {
        console.error("Error initialising emulator:", error);
        benchmarkPage?.fail(error);
        noteError("startup", error);
        modals.showError("initialising", error);
    }
})();

// ------------------------------------------------------------------------
// The console surface the wiki documents, and the desktop app's hooks.
// ------------------------------------------------------------------------

exposeConsoleSurface(window, { loop, processor, video, audioHandler });

// Hooks for electron.
electron({
    settings,
    media,
    drives,
    modals,
    loadStateFile: snapshots.loadStateFromFile.bind(snapshots),
    panels: panelArrangement,
    actions: {
        "soft-reset": () => page.softReset(),
        "hard-reset": () => page.hardReset(),
        "save-state": () => snapshots.saveState(),
        media: () => mediaWindow.open(),
        rewind: () => rewindUI.open(),
        pause: () => loop.stop(true),
        resume: () => loop.go(),
        "toggle-debugger": () => dbgr.toggleDebugger(),
        "toggle-debug-panels": () => dbgr.togglePanels(),
    },
});

// From here on an uncaught error is not a failed start; see src/web/browser-floor.js.
window.jsbeebStartupFinished?.();
