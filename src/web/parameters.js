import { ParamTypes } from "../url-params.js";
import { allModels, findModel, tubeModelFor } from "../models.js";
import { AudioOutputs } from "../audio-output.js";
import { getFilterForMode } from "./canvas.js";

const round = (value) => Number(value.toFixed(2));

/** @returns {string} the speed a multiplier gives this machine's co-processor, e.g. "1.6x (4.8MHz)". */
export function tubeCpuSpeedLabel(multiplier, model) {
    return `${round(multiplier)}x (${round(multiplier * tubeModelFor(model).clockMhz)}MHz)`;
}

const capitalise = (word) => word[0].toUpperCase() + word.substring(1);
const microphoneChannelText = (channel) => (channel === undefined ? "Disabled" : `Channel ${channel}`);

/**
 * Every parameter the page understands, with all it is: its URL `type`, and whether it is a `startupAction` (has the
 * page do something once it is up, rather than describe it), `stored` (kept in browser storage for next time as well
 * as in the URL) or `slid` (changed live as a slider moves, so a burst of changes makes one history entry). A parameter the Settings
 * dialog shows has its `field` there, one of:
 *
 * - `menu`: a dropdown of `options` ({value, text}); the button names the value with `describe`, or the option's text.
 *   The options carry their value as `data-<attribute>`, by default `data-value`. `status` is the id of a line under
 *   the menu for others to fill in.
 * - `check`: a checkbox under a `heading`, with its `hint` beside it.
 * - `range`: a slider over `min`..`max` by `step`, with a `readout(value, proposed)` beside its label if it has one.
 *
 * A menu's `hint` is set small under its label. A field's control has its parameter as its id, with "Dropdown" after it
 * for a menu, unless `id` says otherwise. Changes are saved when the dialog closes, unless the field is `live`; a
 * `restart` field only takes effect on a freshly built machine. `enabledWhen(proposed)` greys a control out unless the
 * settings as they would be saved allow it. `title` is a slider's tooltip, and backquotes mark code.
 */
export const Parameters = {
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
    embed: { type: ParamTypes.BOOL },
    fasttape: { type: ParamTypes.BOOL },
    noseek: { type: ParamTypes.BOOL },
    hasMusic5000: {
        type: ParamTypes.BOOL,
        field: { type: "check", label: "Music 5000 synthesiser", restart: true },
    },
    hasTeletextAdaptor: {
        type: ParamTypes.BOOL,
        field: { type: "check", label: "Teletext adaptor", restart: true },
    },
    hasEconet: {
        type: ParamTypes.BOOL,
        field: { type: "check", label: "Econet with file server", restart: true },
    },
    glEnabled: { type: ParamTypes.BOOL },
    lowLatency: { type: ParamTypes.BOOL },
    fakeVideo: { type: ParamTypes.BOOL },
    logFdcCommands: { type: ParamTypes.BOOL },
    logFdcStateChanges: { type: ParamTypes.BOOL },
    coProcessor: {
        type: ParamTypes.BOOL,
        field: { type: "check", label: "65c02 co-processor", restart: true },
    },
    mouseJoystickEnabled: {
        type: ParamTypes.BOOL,
        field: {
            type: "check",
            heading: "Mouse joystick",
            label: "Enable mouse as analogue joystick",
            hint: "Maps mouse position on BBC display to channels 0 (X) and 1 (Y)",
        },
    },
    speechOutput: {
        type: ParamTypes.BOOL,
        field: {
            type: "check",
            heading: "Text-to-Speech",
            label: "Speak RS-423 serial output (`*FX3,1`)",
            hint:
                "Speaks text sent to the RS-423 port via the browser's Web Speech API. " +
                "Use `*FX3,1` to enable serial output in BBC programs.",
        },
    },
    audioDebug: { type: ParamTypes.BOOL },

    // Numeric parameters
    stationId: { type: ParamTypes.INT },
    frameSkip: { type: ParamTypes.INT },
    videoCyclesBatch: { type: ParamTypes.INT },
    audiofilterfreq: { type: ParamTypes.FLOAT },
    audiofilterq: { type: ParamTypes.FLOAT },
    speakerAmount: {
        type: ParamTypes.FLOAT,
        stored: true,
        slid: true,
        field: {
            type: "range",
            label: "Speaker character",
            live: true,
            enabledWhen: ({ audioOutput }) => audioOutput === AudioOutputs.speaker,
            min: 0,
            max: 1,
            step: 0.05,
            title: "How much of the speaker's character to apply: 0 is the board's output alone",
        },
    },
    palPersistenceMs: { type: ParamTypes.FLOAT, stored: true, slid: true },
    rgbPersistenceMs: { type: ParamTypes.FLOAT, stored: true, slid: true },
    audioLatencyMs: { type: ParamTypes.FLOAT },
    cpuMultiplier: { type: ParamTypes.FLOAT },
    tubeCpuMultiplier: {
        type: ParamTypes.FLOAT,
        field: {
            type: "range",
            label: "Tube CPU",
            readout: (multiplier, { model }) => tubeCpuSpeedLabel(multiplier, findModel(model)),
            enabledWhen: ({ coProcessor }) => coProcessor,
            min: 1,
            max: 8,
            step: 0.05,
        },
    },
    microphoneChannel: {
        type: ParamTypes.INT,
        field: {
            type: "menu",
            label: "Microphone channel",
            describe: microphoneChannelText,
            options: [undefined, 0, 1, 2, 3].map((channel) => ({
                value: channel,
                text: microphoneChannelText(channel),
            })),
            status: "micPermissionStatus",
        },
    },

    // String parameters (these are the default but listed for clarity)
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
    disc: { type: ParamTypes.STRING },
    disc1: { type: ParamTypes.STRING },
    disc2: { type: ParamTypes.STRING },
    tape: { type: ParamTypes.STRING },
    mmc: { type: ParamTypes.STRING },
    keyLayout: {
        type: ParamTypes.STRING,
        stored: true,
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
        stored: true,
        field: {
            type: "menu",
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
    audioOutput: {
        type: ParamTypes.STRING,
        stored: true,
        field: {
            type: "menu",
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
    drive0Tracks: { type: ParamTypes.STRING },
    drive1Tracks: { type: ParamTypes.STRING },
    sbLeft: { type: ParamTypes.STRING },
    sbRight: { type: ParamTypes.STRING },
    sbBottom: { type: ParamTypes.STRING },
};

export const UrlParamTypes = Object.fromEntries(Object.entries(Parameters).map(([name, { type }]) => [name, type]));

const parametersThatAre = (property) => Object.keys(Parameters).filter((name) => Parameters[name][property]);

export const StartupActionParams = parametersThatAre("startupAction");
export const StoredParams = parametersThatAre("stored");
export const SlidParams = parametersThatAre("slid");

/** @returns {object} the Settings dialog field showing `name`, with the parameter it shows as its `setting`. */
export const settingField = (name) => ({ setting: name, ...Parameters[name].field });
