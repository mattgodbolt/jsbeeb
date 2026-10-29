import { buildUrlFromParams, ParamTypes, parseQueryString } from "../url-params.js";
import { allModels, findModel, tubeModelFor } from "../models.js";
import { AudioOutputs, DefaultAudioOutput, isAudioOutput } from "../audio-output.js";
import { getFilterForMode, MaxPersistenceMs, persistenceSettings } from "./canvas.js";
import { mediaLabel, redacted } from "./analytics-filters.js";
import { NumRomBanks } from "../6502.js";

const round = (value) => Number(value.toFixed(2));

/** @returns {string} the speed a multiplier gives this machine's co-processor, e.g. "1.6x (4.8MHz)". */
export function tubeCpuSpeedLabel(multiplier, model) {
    return `${round(multiplier)}x (${round(multiplier * tubeModelFor(model).clockMhz)}MHz)`;
}

/** @returns {number|undefined} the bank a `rom.` parameter names: 0 to 15, with 10 to 15 also written A to F. */
function romBankNumber(member) {
    if (!/^(?:\d{1,2}|[A-F])$/.test(member)) return undefined;
    const bank = parseInt(member, /^[A-F]$/.test(member) ? 16 : 10);
    return bank < NumRomBanks ? bank : undefined;
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

const Peripherals = { label: "Additional peripherals", hint: "(some combinations may cause compatibility issues)" };

/**
 * Every parameter the page understands, with all it is: its URL `type`, and whether it is a `startupAction` (has the
 * page do something once it is up, rather than describe it), `stored` (kept in browser storage for next time as well
 * as in the URL), `slid` (changed live as a slider moves, so a burst of changes makes one history entry),
 * `localToPage` (changes only this page's picture, sound, key mapping or logging, never what the machine does, so a
 * page joining a shared session keeps its own) or `takenFromHost` (changes what the emulated machine does, so a page
 * joining a shared session must run with the host's value, and reloads with it if its own differs). The model is taken
 * from the host too, by code of its own. A BOOL setting that fits something a disc may need is `neededAs` the name a
 * media source's `needs` list gives it, which is also what the user is told the disc needs.
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
 * Analytics is told a parameter's value as its `analyticsFilter`, one of those in analytics-filters.js, returns it;
 * a parameter with none is told as it is. One that is `reportedAtStart` is sent with the machine_start event under its
 * own name, so its values must be a fixed set: a BOOL, or a menu held to its options, by its `valid` or, for the
 * model, by Settings.
 */
export const Parameters = {
    // Shown in the Settings dialog, top to bottom
    model: {
        type: ParamTypes.STRING,
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
        takenFromHost: true,
        default: false,
        field: { type: "check", group: Peripherals, label: "65c02 co-processor", restart: true },
    },
    tubeCpuMultiplier: {
        type: ParamTypes.FLOAT,
        takenFromHost: true,
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
        takenFromHost: true,
        default: false,
        field: { type: "check", group: Peripherals, label: "Music 5000 synthesiser", restart: true },
    },
    hasTeletextAdaptor: {
        type: ParamTypes.BOOL,
        takenFromHost: true,
        default: false,
        field: { type: "check", group: Peripherals, label: "Teletext adaptor", restart: true },
    },
    hasEconet: {
        type: ParamTypes.BOOL,
        takenFromHost: true,
        default: false,
        field: { type: "check", group: Peripherals, label: "Econet with file server", restart: true },
    },
    hasVideoNula: {
        type: ParamTypes.BOOL,
        takenFromHost: true,
        neededAs: "VideoNuLA",
        default: false,
        field: {
            type: "check",
            group: Peripherals,
            label: "VideoNuLA (4096-colour palette)",
            restart: true,
            enabledWhen: ({ model }) => !findModel(model).isAtom,
        },
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
    autotype: { type: ParamTypes.STRING, startupAction: true, analyticsFilter: redacted },
    loadBasic: { type: ParamTypes.STRING, startupAction: true, analyticsFilter: mediaLabel },
    embedBasic: { type: ParamTypes.STRING, startupAction: true, analyticsFilter: redacted },
    patch: { type: ParamTypes.STRING, startupAction: true, analyticsFilter: redacted },
    benchmark: { type: ParamTypes.STRING, startupAction: true },

    // Array parameters
    rom: { type: ParamTypes.ARRAY, analyticsFilter: mediaLabel },

    // Boolean parameters
    embed: { type: ParamTypes.BOOL, localToPage: true, reportedAtStart: true },
    touchkeys: { type: ParamTypes.BOOL, localToPage: true },
    fasttape: { type: ParamTypes.BOOL },
    noseek: { type: ParamTypes.BOOL },
    glEnabled: { type: ParamTypes.BOOL_DEFAULT_TRUE, localToPage: true },
    lowLatency: { type: ParamTypes.BOOL_DEFAULT_TRUE, localToPage: true },
    fakeVideo: { type: ParamTypes.BOOL, takenFromHost: true },
    logFdcCommands: { type: ParamTypes.BOOL, localToPage: true },
    logFdcStateChanges: { type: ParamTypes.BOOL, localToPage: true },
    audioDebug: { type: ParamTypes.BOOL, localToPage: true },

    // Numeric parameters
    stationId: { type: ParamTypes.INT, takenFromHost: true },
    frameSkip: { type: ParamTypes.INT },
    videoCyclesBatch: { type: ParamTypes.INT, takenFromHost: true },
    audiofilterfreq: { type: ParamTypes.FLOAT, localToPage: true },
    audiofilterq: { type: ParamTypes.FLOAT, localToPage: true },
    audioLatencyMs: { type: ParamTypes.FLOAT, localToPage: true },
    cpuMultiplier: { type: ParamTypes.FLOAT, takenFromHost: true },

    // String parameters (these are the default but listed for clarity)
    disc: { type: ParamTypes.STRING, analyticsFilter: mediaLabel },
    disc1: { type: ParamTypes.STRING, analyticsFilter: mediaLabel },
    disc2: { type: ParamTypes.STRING, analyticsFilter: mediaLabel },
    tape: { type: ParamTypes.STRING, analyticsFilter: mediaLabel },
    mmc: { type: ParamTypes.STRING, analyticsFilter: mediaLabel },
    drive0Tracks: { type: ParamTypes.STRING },
    drive1Tracks: { type: ParamTypes.STRING },
    sbLeft: { type: ParamTypes.STRING, localToPage: true },
    sbRight: { type: ParamTypes.STRING, localToPage: true },
    sbBottom: { type: ParamTypes.STRING, localToPage: true },

    // A shared session's room, and the name its user goes by there
    server: { type: ParamTypes.STRING, analyticsFilter: redacted },
    client: { type: ParamTypes.STRING, analyticsFilter: redacted },
    name: { type: ParamTypes.STRING, analyticsFilter: redacted },

    // Families
    // Host key names are keymap.js's, so the BBC's RETURN is ENTER here; both lists are in the README.
    keyMapping: {
        prefix: "KEY.",
        type: ParamTypes.STRING,
        localToPage: true,
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
        apply: (control, machineKey, { gamepad }) => gamepad.remap(control, machineKey),
    },
    romBank: {
        prefix: "ROM.",
        type: ParamTypes.ARRAY,
        analyticsFilter: mediaLabel,
        apply: (member, refs, { bankRoms }) => {
            const bank = romBankNumber(member);
            if (bank === undefined) return `"${member}" is not a ROM bank, which is 0 to 15, or A to F in hex.`;
            const [rom, ...others] = refs.filter((ref) => ref);
            if (!rom) return;
            const earlier = bankRoms.find((named) => named.bank === bank);
            if (earlier) return `bank ${bank} already has ${earlier.rom}, so ${rom} is not loaded.`;
            bankRoms.push({ bank, rom });
            if (others.length) return `bank ${bank} takes one ROM, so ${others.join(", ")} is not loaded.`;
        },
    },
    labelFiles: {
        prefix: "LABELS.",
        names: ["labels"],
        type: ParamTypes.ARRAY,
        localToPage: true,
        analyticsFilter: mediaLabel,
        apply: (member, urls, { labelFiles }) => {
            const bank = member === "labels" ? null : romBankNumber(member);
            if (bank === undefined) return `"${member}" is not a ROM bank, which is 0 to 15, or A to F in hex.`;
            for (const url of urls.filter((url) => url)) labelFiles.push({ url, bank });
        },
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

const takenFromHostEntries = (parameters) =>
    Object.entries(parameters).filter(([, { takenFromHost }]) => takenFromHost);

const usableAs = {
    [ParamTypes.BOOL]: (value) => value === true,
    [ParamTypes.INT]: (value) => (Number.isInteger(value) ? value : undefined),
    [ParamTypes.FLOAT]: (value) => (Number.isFinite(value) ? value : undefined),
    [ParamTypes.STRING]: (value) => (typeof value === "string" ? value : undefined),
    [ParamTypes.ARRAY]: (value) =>
        Array.isArray(value) && value.every((each) => typeof each === "string") ? value : undefined,
};

/**
 * @returns {object} the value of every parameter a session guest takes from its host, as this page's start gave it: a
 * setting's from `settings`, any other's from the page's parsed URL `params`, absent if the URL has none
 */
export function takenFromHostValues(settings, params, parameters = Parameters) {
    return Object.fromEntries(
        takenFromHostEntries(parameters).map(([name, parameter]) => [
            name,
            usableAs[parameter.type]("default" in parameter ? settings[name] : params[name]),
        ]),
    );
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function survivesUrl(name, type, value) {
    const typeOf = () => type;
    const url = buildUrlFromParams("", { [name]: value }, typeOf);
    return sameValue(usableAs[type](parseQueryString(url.substring(1), typeOf)[name]), value);
}

const acceptable = (name, { type, valid, fit }, value) =>
    value === undefined ||
    ((!valid || valid(value)) && (!fit || fit(value) === value) && survivesUrl(name, type, value));

/**
 * @returns {object|null} the values of the parameters a session guest takes from its host, as the host `sent` them in
 * its welcome, or null if one is a value this page would not take from its own URL, so reloading with it could never
 * match; one its parameter's type cannot take counts as none, which for a setting is its default.
 */
export function readTakenFromHost(sent, parameters = Parameters) {
    const entries = takenFromHostEntries(parameters).map(([name, parameter]) => [
        name,
        usableAs[parameter.type](sent?.[name]) ?? parameter.default,
        parameter,
    ]);
    if (!entries.every(([name, value, parameter]) => acceptable(name, parameter, value))) return null;
    return Object.fromEntries(entries.map(([name, value]) => [name, value]));
}

/** @returns {boolean} whether this page's `own` takenFromHostValues are the `host`'s. */
export const matchesHost = (host, own) => Object.keys(host).every((name) => sameValue(host[name], own[name]));

/**
 * Puts each parameter in `params` that a family applies into effect.
 * @param {object} params - The page's parsed parameters
 * @param {{machineKeys: object, hostKeyCodes: (name: string) => string[], userKeymap: object[], gamepad: object,
 *     bankRoms: {bank: number, rom: string}[], labelFiles: {url: string, bank: number | null}[]}} context - What the
 *     families need from the page: the emulated machine's keys (`BBC`, or `ATOM` for the Atom), and the lists the ROMs
 *     named for a bank and the label files go in
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

/** The check boxes under the Settings dialog's peripherals: each fits something to the machine, or leaves it off. */
export const FittingParams = Object.keys(Parameters).filter(
    (name) => Parameters[name].type === ParamTypes.BOOL && Parameters[name].field?.group === Peripherals,
);
