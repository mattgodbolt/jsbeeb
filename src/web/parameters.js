import { ParamTypes } from "../url-params.js";
import { allModels, findModel, tubeModelFor } from "../models.js";
import { AudioOutputs, DefaultAudioOutput, isAudioOutput } from "../audio-output.js";
import { getFilterForMode, MaxPersistenceMs, persistenceSettings } from "./canvas.js";
import { asIs, mediaLabel, redacted } from "./analytics-filters.js";

const round = (value) => Number(value.toFixed(2));

/** @returns {string} the speed a multiplier gives this machine's co-processor, e.g. "1.6x (4.8MHz)". */
export function tubeCpuSpeedLabel(multiplier, model) {
    return `${round(multiplier)}x (${round(multiplier * tubeModelFor(model).clockMhz)}MHz)`;
}

const capitalise = (word) => word[0].toUpperCase() + word.substring(1);
const isOption = (options) => (value) => options.some((option) => option.value === value);

const KeyLayoutOptions = [
    { value: "physical", text: "Physical: '*' is next to Enter/Return" },
    { value: "natural", text: "Natural: you get the character you type" },
    { value: "gaming", text: "Gaming: handy for games like Zalaga" },
];
const microphoneChannelText = (channel) => (channel === undefined ? "Disabled" : `Channel ${channel}`);

const AfterglowDefaults = Object.fromEntries(persistenceSettings().map(({ setting, default: ms }) => [setting, ms]));
const clampAfterglow = (ms) => Math.min(MaxPersistenceMs, Math.max(0, ms));

export const DisplaySection = "display";

export const RequiredProperties = ["type", "localToPage", "analyticsFilter"];

const Peripherals = { label: "Additional peripherals", hint: "(some combinations may cause compatibility issues)" };

/**
 * Every parameter the page understands, with all it is: its URL `type`, whether it is `localToPage` (changes only this
 * page's picture, sound, key mapping or logging, never what the machine does, so a page joining a shared session keeps
 * its own), its `analyticsFilter`, and whether it is a `startupAction` (has the page do something once it is up, rather
 * than describe it), `stored` (kept in browser storage for next time as well as in the URL) or `slid` (changed live as
 * a slider moves, so a burst of changes makes one history entry). Every entry declares each of RequiredProperties.
 *
 * A family is an entry for every parameter whose name starts with its `prefix`, in any case, or is one of its `names`;
 * the entry's own key is not a parameter. Its `apply(member, value, context)` puts one of them into effect, given the
 * rest of its name (or the whole of one of its `names`) and its value as its `type` parses it, both upper-cased if they
 * are strings, and returns what is wrong with it if it cannot. One whose value parses as null or an empty string is
 * skipped. Settings, storage and the dialog work by name, so a family has none of their properties.
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
 *
 * Analytics is told a parameter's value as its `analyticsFilter`, one of those in analytics-filters.js, returns it.
 * One that is `reportedAtStart` is sent with the machine_start event under its own name, so its values must be a fixed
 * set: a BOOL, or a menu held to its options, by its `valid` or, for the model, by Settings.
 */
export const Parameters = {
    // Shown in the Settings dialog, top to bottom
    model: {
        type: ParamTypes.STRING,
        localToPage: false,
        analyticsFilter: asIs,
        reportedAtStart: true,
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
        analyticsFilter: asIs,
        localToPage: true,
        stored: true,
        default: "physical",
        reportedAtStart: true,
        fromUrl: (layout) => layout.toLowerCase(),
        valid: isOption(KeyLayoutOptions),
        field: {
            type: "menu",
            label: "Keyboard layout",
            describe: capitalise,
            options: KeyLayoutOptions,
        },
    },
    displayMode: {
        type: ParamTypes.STRING,
        analyticsFilter: asIs,
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
        localToPage: false,
        analyticsFilter: asIs,
        default: false,
        field: { type: "check", group: Peripherals, label: "65c02 co-processor", restart: true },
    },
    tubeCpuMultiplier: {
        type: ParamTypes.FLOAT,
        localToPage: false,
        analyticsFilter: asIs,
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
        localToPage: false,
        analyticsFilter: asIs,
        default: false,
        field: { type: "check", group: Peripherals, label: "Music 5000 synthesiser", restart: true },
    },
    hasTeletextAdaptor: {
        type: ParamTypes.BOOL,
        localToPage: false,
        analyticsFilter: asIs,
        default: false,
        field: { type: "check", group: Peripherals, label: "Teletext adaptor", restart: true },
    },
    hasEconet: {
        type: ParamTypes.BOOL,
        localToPage: false,
        analyticsFilter: asIs,
        default: false,
        field: { type: "check", group: Peripherals, label: "Econet with file server", restart: true },
    },
    audioOutput: {
        type: ParamTypes.STRING,
        analyticsFilter: asIs,
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
        analyticsFilter: asIs,
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
        localToPage: false,
        analyticsFilter: asIs,
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
        localToPage: false,
        analyticsFilter: asIs,
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
        analyticsFilter: asIs,
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
        analyticsFilter: asIs,
        localToPage: true,
        stored: true,
        slid: true,
        default: AfterglowDefaults.palPersistenceMs,
        fit: clampAfterglow,
    },
    rgbPersistenceMs: {
        type: ParamTypes.FLOAT,
        analyticsFilter: asIs,
        localToPage: true,
        stored: true,
        slid: true,
        default: AfterglowDefaults.rgbPersistenceMs,
        fit: clampAfterglow,
    },

    // Startup actions
    autoboot: { type: ParamTypes.BOOL, localToPage: false, startupAction: true, analyticsFilter: asIs },
    autochain: { type: ParamTypes.BOOL, localToPage: false, startupAction: true, analyticsFilter: asIs },
    autorun: { type: ParamTypes.BOOL, localToPage: false, startupAction: true, analyticsFilter: asIs },
    autotype: { type: ParamTypes.STRING, localToPage: false, startupAction: true, analyticsFilter: redacted },
    loadBasic: { type: ParamTypes.STRING, localToPage: false, startupAction: true, analyticsFilter: mediaLabel },
    embedBasic: { type: ParamTypes.STRING, localToPage: false, startupAction: true, analyticsFilter: redacted },
    patch: { type: ParamTypes.STRING, localToPage: false, startupAction: true, analyticsFilter: redacted },

    // Array parameters
    rom: { type: ParamTypes.ARRAY, localToPage: false, analyticsFilter: mediaLabel },

    // Boolean parameters
    embed: { type: ParamTypes.BOOL, localToPage: true, reportedAtStart: true, analyticsFilter: asIs },
    fasttape: { type: ParamTypes.BOOL, localToPage: false, analyticsFilter: asIs },
    noseek: { type: ParamTypes.BOOL, localToPage: false, analyticsFilter: asIs },
    glEnabled: { type: ParamTypes.BOOL, localToPage: true, analyticsFilter: asIs },
    lowLatency: { type: ParamTypes.BOOL, localToPage: true, analyticsFilter: asIs },
    fakeVideo: { type: ParamTypes.BOOL, localToPage: false, analyticsFilter: asIs },
    logFdcCommands: { type: ParamTypes.BOOL, localToPage: true, analyticsFilter: asIs },
    logFdcStateChanges: { type: ParamTypes.BOOL, localToPage: true, analyticsFilter: asIs },
    audioDebug: { type: ParamTypes.BOOL, localToPage: true, analyticsFilter: asIs },

    // Numeric parameters
    stationId: { type: ParamTypes.INT, localToPage: false, analyticsFilter: asIs },
    frameSkip: { type: ParamTypes.INT, localToPage: false, analyticsFilter: asIs },
    videoCyclesBatch: { type: ParamTypes.INT, localToPage: false, analyticsFilter: asIs },
    audiofilterfreq: { type: ParamTypes.FLOAT, localToPage: true, analyticsFilter: asIs },
    audiofilterq: { type: ParamTypes.FLOAT, localToPage: true, analyticsFilter: asIs },
    audioLatencyMs: { type: ParamTypes.FLOAT, localToPage: true, analyticsFilter: asIs },
    cpuMultiplier: { type: ParamTypes.FLOAT, localToPage: false, analyticsFilter: asIs },

    // String parameters
    disc: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: mediaLabel },
    disc1: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: mediaLabel },
    disc2: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: mediaLabel },
    tape: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: mediaLabel },
    mmc: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: mediaLabel },
    drive0Tracks: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: asIs },
    drive1Tracks: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: asIs },
    sbLeft: { type: ParamTypes.STRING, localToPage: true, analyticsFilter: asIs },
    sbRight: { type: ParamTypes.STRING, localToPage: true, analyticsFilter: asIs },
    sbBottom: { type: ParamTypes.STRING, localToPage: true, analyticsFilter: asIs },

    // A shared session's room, and the name its user goes by there
    server: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: redacted },
    client: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: redacted },
    name: { type: ParamTypes.STRING, localToPage: false, analyticsFilter: redacted },

    // Families
    // Host key names are keymap.js's, so the BBC's RETURN is ENTER here; both lists are in the README.
    keyMapping: {
        prefix: "KEY.",
        type: ParamTypes.STRING,
        localToPage: true,
        analyticsFilter: asIs,
        apply: (hostKey, machineKey, { machineKeys, hostKeyCodes, userKeymap }) => {
            if (!machineKeys[machineKey]) return `"${machineKey}" is not a key on the emulated machine.`;
            if (hostKeyCodes(hostKey).length === 0) return `"${hostKey}" is not a key on your keyboard.`;
            userKeymap.push({ native: hostKey, key: machineKey });
        },
    },
    gamepadMapping: {
        prefix: "GP.",
        names: ["LEFT", "RIGHT", "UP", "DOWN", "FIRE"],
        type: ParamTypes.STRING,
        localToPage: true,
        analyticsFilter: asIs,
        apply: (control, bbcKey, { gamepad }) => gamepad.remap(control, bbcKey),
    },
};

/**
 * @returns {{parameter: object, member?: string}|undefined} the entry the parameter `name` is, or the family it is in
 * with the part of its name that family maps (the host key, the gamepad control).
 */
export function parameterFor(name, parameters = Parameters) {
    if (Object.hasOwn(parameters, name) && !parameters[name].prefix) return { parameter: parameters[name] };
    for (const parameter of Object.values(parameters)) {
        if (!parameter.prefix) continue;
        if (parameter.names?.includes(name)) return { parameter, member: name };
        if (name.toUpperCase().startsWith(parameter.prefix))
            return { parameter, member: name.substring(parameter.prefix.length).toUpperCase() };
    }
    return undefined;
}

/** @returns {string|undefined} the URL type of the parameter `name`, as the URL parser takes it. */
export const urlParamType = (name, parameters = Parameters) => parameterFor(name, parameters)?.parameter.type;

export const StartupActionParams = Object.keys(Parameters).filter((name) => Parameters[name].startupAction);

/**
 * Puts each parameter in `params` that a family applies into effect.
 * @param {object} params - The page's parsed parameters
 * @param {{machineKeys: object, hostKeyCodes: (name: string) => string[], userKeymap: object[], gamepad: object}}
 *     context - What the families need from the page: the emulated machine's keys (`BBC`, or `ATOM` for the Atom)
 * @returns {string[]} what is wrong with each that could not be, for showing to the user
 */
export function processInputParams(params, context) {
    const warnings = [];
    for (const [name, value] of Object.entries(params)) {
        const { parameter, member } = parameterFor(name) ?? {};
        if (!parameter?.apply || value === null || value === "") continue;
        const problem = parameter.apply(member, typeof value === "string" ? value.toUpperCase() : value, context);
        if (problem) warnings.push(`${name}=${value}: ${problem}`);
    }
    return warnings;
}
