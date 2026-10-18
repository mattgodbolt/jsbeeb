import { ParamTypes } from "../url-params.js";
import { allModels, findModel, tubeModelFor } from "../models.js";
import { AudioOutputs, DefaultAudioOutput, isAudioOutput } from "../audio-output.js";
import { getFilterForMode, MaxPersistenceMs, persistenceSettings } from "./canvas.js";

const round = (value) => Number(value.toFixed(2));

/** @returns {string} the speed a multiplier gives this machine's co-processor, e.g. "1.6x (4.8MHz)". */
export function tubeCpuSpeedLabel(multiplier, model) {
    return `${round(multiplier)}x (${round(multiplier * tubeModelFor(model).clockMhz)}MHz)`;
}

const capitalise = (word) => word[0].toUpperCase() + word.substring(1);
const microphoneChannelText = (channel) => (channel === undefined ? "Disabled" : `Channel ${channel}`);

const AfterglowDefaults = Object.fromEntries(persistenceSettings().map(({ setting, default: ms }) => [setting, ms]));
const clampAfterglow = (ms) => Math.min(MaxPersistenceMs, Math.max(0, ms));

export const DisplaySection = "display";

const Peripherals = { label: "Additional peripherals", hint: "(some combinations may cause compatibility issues)" };

/**
 * Every parameter the page understands, with all it is: its URL `type`, and whether it is a `startupAction` (has the
 * page do something once it is up, rather than describe it), `stored` (kept in browser storage for next time as well
 * as in the URL), `slid` (changed live as a slider moves, so a burst of changes makes one history entry) or
 * `localToPage` (changes how this page shows, sounds or takes keys for the machine, never what the machine does, so a
 * page joining a shared session keeps its own).
 *
 * A setting is the model, which Settings resolves with code of its own, or a parameter with a `default`, which Settings
 * takes from the URL, then from storage if it is stored, then the default. `fromUrl` adjusts a value from the URL, and
 * the value is then used if it suits its type (a string that is not empty, a finite number) and `valid` allows it;
 * `fit` brings whichever value is used into range. A setting cleared is back at its default.
 *
 * A setting the Settings dialog shows has its `field` there; the dialog lists them in the order they are declared
 * here. A field in a `section` is set off with the others in it, and one in a `group` sits in a column beside the
 * group's label. A field is one of:
 *
 * - `menu`: a dropdown of `options` ({value, text}); the button names the value with `describe`, or the option's text.
 *   The options carry their value as `data-<attribute>`, by default `data-value`. `status` is the id of a line under
 *   the menu for others to fill in.
 * - `check`: a checkbox under a `heading`, with its `hint` beside it, or in a group, beside its label.
 * - `range`: a slider over `min`..`max` by `step`, with a `readout(value, proposed)` beside its label if it has one.
 *
 * A menu's `hint` is set small under its label. A field's control has its parameter as its id, with "Dropdown" after it
 * for a menu, unless `id` says otherwise. Changes are saved when the dialog closes, unless the field is `live`; a
 * `restart` field only takes effect on a freshly built machine. `enabledWhen(proposed)` greys a control out unless the
 * settings as they would be saved allow it. `title` is a slider's tooltip, and backquotes mark code.
 */
export const Parameters = {
    // Shown in the Settings dialog, top to bottom
    model: {
        type: ParamTypes.STRING,
        field: {
            type: "menu",
            id: "bbc-model-dropdown",
            attribute: "target",
            label: "Base model",
            hint: "(including disk interface)",
            restart: true,
            describe: (model) => findModel(model).name,
            options: allModels
                .filter((model) => model.synonyms.length > 0)
                .map((model) => ({ value: model.synonyms[0], text: model.name })),
        },
    },
    keyLayout: {
        type: ParamTypes.STRING,
        localToPage: true,
        stored: true,
        default: "physical",
        fromUrl: (layout) => layout.toLowerCase(),
        field: {
            type: "menu",
            label: "Keyboard layout",
            describe: capitalise,
            options: [
                { value: "physical", text: "Physical: '*' is next to Enter/Return" },
                { value: "natural", text: "Natural: you get the character you type" },
                { value: "gaming", text: "Gaming: handy for games like Zalaga" },
            ],
        },
    },
    displayMode: {
        type: ParamTypes.STRING,
        localToPage: true,
        stored: true,
        default: "rgb",
        field: {
            type: "menu",
            section: DisplaySection,
            label: "Display mode",
            live: true,
            describe: (mode) => getFilterForMode(mode).getDisplayConfig().name,
            options: [
                { value: "rgb", text: "RGB Monitor" },
                { value: "pal", text: "PAL TV" },
                { value: "xbr", text: "Smoothed (xBR)" },
            ],
        },
    },
    coProcessor: {
        type: ParamTypes.BOOL,
        default: false,
        field: { type: "check", group: Peripherals, label: "65c02 co-processor", restart: true },
    },
    tubeCpuMultiplier: {
        type: ParamTypes.FLOAT,
        default: 1,
        valid: (multiplier) => multiplier !== 0,
        field: {
            type: "range",
            group: Peripherals,
            label: "Tube CPU",
            readout: (multiplier, { model }) => tubeCpuSpeedLabel(multiplier, findModel(model)),
            enabledWhen: ({ coProcessor }) => coProcessor,
            min: 1,
            max: 8,
            step: 0.05,
        },
    },
    hasMusic5000: {
        type: ParamTypes.BOOL,
        default: false,
        field: { type: "check", group: Peripherals, label: "Music 5000 synthesiser", restart: true },
    },
    hasTeletextAdaptor: {
        type: ParamTypes.BOOL,
        default: false,
        field: { type: "check", group: Peripherals, label: "Teletext adaptor", restart: true },
    },
    hasEconet: {
        type: ParamTypes.BOOL,
        default: false,
        field: { type: "check", group: Peripherals, label: "Econet with file server", restart: true },
    },
    audioOutput: {
        type: ParamTypes.STRING,
        localToPage: true,
        stored: true,
        default: DefaultAudioOutput,
        valid: isAudioOutput,
        field: {
            type: "menu",
            section: "sound",
            attribute: "output",
            label: "Sound output",
            live: true,
            options: [
                { value: AudioOutputs.speaker, text: "Internal speaker" },
                { value: AudioOutputs.board, text: "Line out" },
                { value: AudioOutputs.off, text: "Unfiltered" },
            ],
        },
    },
    speakerAmount: {
        type: ParamTypes.FLOAT,
        localToPage: true,
        stored: true,
        slid: true,
        default: 1,
        field: {
            type: "range",
            section: "sound",
            label: "Speaker character",
            live: true,
            enabledWhen: ({ audioOutput }) => audioOutput === AudioOutputs.speaker,
            min: 0,
            max: 1,
            step: 0.05,
            title: "How much of the speaker's character to apply: 0 is the board's output alone",
        },
    },
    microphoneChannel: {
        type: ParamTypes.INT,
        default: undefined,
        field: {
            type: "menu",
            section: "microphone",
            label: "Microphone channel",
            describe: microphoneChannelText,
            options: [undefined, 0, 1, 2, 3].map((channel) => ({
                value: channel,
                text: microphoneChannelText(channel),
            })),
            status: "micPermissionStatus",
        },
    },
    mouseJoystickEnabled: {
        type: ParamTypes.BOOL,
        default: false,
        field: {
            type: "check",
            section: "mouse",
            heading: "Mouse joystick",
            label: "Enable mouse as analogue joystick",
            hint: "Maps mouse position on BBC display to channels 0 (X) and 1 (Y)",
        },
    },
    speechOutput: {
        type: ParamTypes.BOOL,
        localToPage: true,
        default: false,
        field: {
            type: "check",
            section: "speech",
            heading: "Text-to-Speech",
            label: "Speak RS-423 serial output (`*FX3,1`)",
            hint:
                "Speaks text sent to the RS-423 port via the browser's Web Speech API. " +
                "Use `*FX3,1` to enable serial output in BBC programs.",
        },
    },

    // Each display's afterglow
    palPersistenceMs: {
        type: ParamTypes.FLOAT,
        localToPage: true,
        stored: true,
        slid: true,
        default: AfterglowDefaults.palPersistenceMs,
        fit: clampAfterglow,
    },
    rgbPersistenceMs: {
        type: ParamTypes.FLOAT,
        localToPage: true,
        stored: true,
        slid: true,
        default: AfterglowDefaults.rgbPersistenceMs,
        fit: clampAfterglow,
    },

    // Startup actions
    autoboot: { type: ParamTypes.BOOL, startupAction: true },
    autochain: { type: ParamTypes.BOOL, startupAction: true },
    autorun: { type: ParamTypes.BOOL, startupAction: true },
    autotype: { type: ParamTypes.STRING, startupAction: true },
    loadBasic: { type: ParamTypes.STRING, startupAction: true },
    embedBasic: { type: ParamTypes.STRING, startupAction: true },
    patch: { type: ParamTypes.STRING, startupAction: true },

    // Array parameters
    rom: { type: ParamTypes.ARRAY },

    // Boolean parameters
    embed: { type: ParamTypes.BOOL, localToPage: true },
    fasttape: { type: ParamTypes.BOOL },
    noseek: { type: ParamTypes.BOOL },
    glEnabled: { type: ParamTypes.BOOL, localToPage: true },
    lowLatency: { type: ParamTypes.BOOL, localToPage: true },
    fakeVideo: { type: ParamTypes.BOOL },
    logFdcCommands: { type: ParamTypes.BOOL, localToPage: true },
    logFdcStateChanges: { type: ParamTypes.BOOL, localToPage: true },
    audioDebug: { type: ParamTypes.BOOL, localToPage: true },

    // Numeric parameters
    stationId: { type: ParamTypes.INT },
    frameSkip: { type: ParamTypes.INT },
    videoCyclesBatch: { type: ParamTypes.INT },
    audiofilterfreq: { type: ParamTypes.FLOAT, localToPage: true },
    audiofilterq: { type: ParamTypes.FLOAT, localToPage: true },
    audioLatencyMs: { type: ParamTypes.FLOAT, localToPage: true },
    cpuMultiplier: { type: ParamTypes.FLOAT },

    // String parameters (these are the default but listed for clarity)
    disc: { type: ParamTypes.STRING },
    disc1: { type: ParamTypes.STRING },
    disc2: { type: ParamTypes.STRING },
    tape: { type: ParamTypes.STRING },
    mmc: { type: ParamTypes.STRING },
    drive0Tracks: { type: ParamTypes.STRING },
    drive1Tracks: { type: ParamTypes.STRING },
    sbLeft: { type: ParamTypes.STRING, localToPage: true },
    sbRight: { type: ParamTypes.STRING, localToPage: true },
    sbBottom: { type: ParamTypes.STRING, localToPage: true },
};

/** @returns {Object.<string, string>} each parameter's URL type, as the URL parser takes them. */
export const urlParamTypes = (parameters) =>
    Object.fromEntries(Object.entries(parameters).map(([name, { type }]) => [name, type]));

export const UrlParamTypes = urlParamTypes(Parameters);

export const StartupActionParams = Object.keys(Parameters).filter((name) => Parameters[name].startupAction);

export const LocalToPageParams = Object.keys(Parameters).filter((name) => Parameters[name].localToPage);
