import { allModels, findModel, tubeModelFor } from "../models.js";
import { AudioOutputs } from "../audio-output.js";
import { getFilterForMode, MaxPersistenceMs } from "./canvas.js";

const round = (value) => Number(value.toFixed(2));

/** @returns {string} the speed a multiplier gives this machine's co-processor, e.g. "1.6x (4.8MHz)". */
export function tubeCpuSpeedLabel(multiplier, model) {
    return `${round(multiplier)}x (${round(multiplier * tubeModelFor(model).clockMhz)}MHz)`;
}

const capitalise = (word) => word[0].toUpperCase() + word.substring(1);
const microphoneChannelText = (channel) => (channel === undefined ? "Disabled" : `Channel ${channel}`);

/**
 * The Settings dialog, as paragraphs of fields. A field shows one setting (or none, for the afterglow slider, which
 * edits whichever setting the display in use has), and is one of:
 *
 * - `menu`: a dropdown of `options` ({value, text}); the button names the value with `describe`, or the option's text.
 *   The options carry their value as `data-<attribute>`, by default `data-value`. `status` is the id of a line under
 *   the menu for others to fill in.
 * - `check`: a checkbox.
 * - `range`: a slider over `min`..`max` by `step`, with a `readout(value, proposed)` beside its label if it has one.
 * - `group`: a label beside a column of `fields`, each a check or a range.
 *
 * A field's control has its setting as its id, with "Dropdown" after it for a menu, unless `id` says otherwise.
 * Changes are saved when the dialog closes, unless the field is `live`; a `restart` field only takes effect on a
 * freshly built machine. `enabledWhen(proposed)` greys a control out unless the settings as they would be saved allow
 * it. `title` is the tooltip, and backquotes in a label mark code.
 */
export const ConfigForm = [
    [
        {
            type: "menu",
            setting: "model",
            id: "bbc-model-dropdown",
            attribute: "target",
            label: "Base model",
            title: "Including its disc interface",
            restart: true,
            options: allModels
                .filter((model) => model.synonyms.length > 0)
                .map((model) => ({ value: model.synonyms[0], text: model.name })),
        },
        {
            type: "menu",
            setting: "keyLayout",
            label: "Keyboard layout",
            describe: capitalise,
            options: [
                { value: "physical", text: "Physical: '*' is next to Enter/Return" },
                { value: "natural", text: "Natural: you get the character you type" },
                { value: "gaming", text: "Gaming: handy for games like Zalaga" },
            ],
        },
    ],
    [
        {
            type: "menu",
            setting: "displayMode",
            label: "Display mode",
            live: true,
            describe: (mode) => getFilterForMode(mode).getDisplayConfig().name,
            options: [
                { value: "rgb", text: "RGB Monitor" },
                { value: "pal", text: "PAL TV" },
                { value: "xbr", text: "Smoothed (xBR)" },
            ],
        },
        {
            type: "range",
            id: "persistence",
            label: "Phosphor afterglow",
            readout: (afterglowMs) => (afterglowMs > 0 ? `${afterglowMs} ms` : "none"),
            min: 0,
            max: MaxPersistenceMs,
            step: 5,
            title: "How long the last picture takes to fade under the next, in milliseconds: 0 is no afterglow",
        },
    ],
    [
        {
            type: "group",
            label: "Additional peripherals",
            title: "Some combinations may cause compatibility issues",
            fields: [
                { type: "check", setting: "coProcessor", label: "65c02 co-processor", restart: true },
                {
                    type: "range",
                    setting: "tubeCpuMultiplier",
                    label: "Tube CPU",
                    readout: (multiplier, { model }) => tubeCpuSpeedLabel(multiplier, findModel(model)),
                    enabledWhen: ({ coProcessor }) => coProcessor,
                    min: 1,
                    max: 8,
                    step: 0.05,
                },
                { type: "check", setting: "hasMusic5000", label: "Music 5000 synthesiser", restart: true },
                { type: "check", setting: "hasTeletextAdaptor", label: "Teletext adaptor", restart: true },
                { type: "check", setting: "hasEconet", label: "Econet with file server", restart: true },
            ],
        },
    ],
    [
        {
            type: "menu",
            setting: "audioOutput",
            attribute: "output",
            label: "Sound output",
            live: true,
            options: [
                { value: AudioOutputs.speaker, text: "Internal speaker" },
                { value: AudioOutputs.board, text: "Line out" },
                { value: AudioOutputs.off, text: "Unfiltered" },
            ],
        },
        {
            type: "range",
            setting: "speakerAmount",
            label: "Speaker character",
            live: true,
            enabledWhen: ({ audioOutput }) => audioOutput === AudioOutputs.speaker,
            min: 0,
            max: 1,
            step: 0.05,
            title: "How much of the speaker's character to apply: 0 is the board's output alone",
        },
    ],
    [
        {
            type: "menu",
            setting: "microphoneChannel",
            label: "Microphone channel",
            describe: microphoneChannelText,
            options: [undefined, 0, 1, 2, 3].map((channel) => ({
                value: channel,
                text: microphoneChannelText(channel),
            })),
            status: "micPermissionStatus",
        },
    ],
    [
        {
            type: "group",
            label: "Mouse joystick",
            fields: [
                {
                    type: "check",
                    setting: "mouseJoystickEnabled",
                    label: "Enable mouse as analogue joystick",
                    title: "Maps the mouse position on the BBC display to analogue channels 0 (X) and 1 (Y)",
                },
            ],
        },
    ],
    [
        {
            type: "group",
            label: "Text-to-Speech",
            fields: [
                {
                    type: "check",
                    setting: "speechOutput",
                    label: "Speak RS-423 serial output (`*FX3,1`)",
                    title: "Speaks the text sent to the RS-423 port, using the browser's Web Speech API",
                },
            ],
        },
    ],
];

/** @returns {object[]} every field in the form that shows a setting, groups flattened. */
export function settingFields(form = ConfigForm) {
    return form
        .flat()
        .flatMap((field) => (field.type === "group" ? field.fields : [field]))
        .filter((field) => field.setting);
}

/** @returns {string} the id of the element a field's value is shown in. */
export function controlId(field) {
    return field.id ?? (field.type === "menu" ? `${field.setting}Dropdown` : field.setting);
}

/** @returns {string} the id of a range's readout. */
export function readoutId(field) {
    return `${controlId(field)}Value`;
}

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const element = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(name, value);
    node.append(...children);
    return node;
};

const withCode = (text) => text.split("`").map((part, index) => (index % 2 ? element("code", {}, part) : part));

const row = (label, control) =>
    element("div", { class: "row align-items-center" }, element("div", { class: "col-sm-6" }, label), control);

const rowLabel = (field, ...extra) =>
    element(
        "label",
        { for: field.type === "group" ? undefined : controlId(field), class: "col-form-label", title: field.title },
        ...withCode(field.label),
        ":",
        ...extra,
    );

const readout = (field) => (field.readout ? [" ", element("span", { id: readoutId(field) })] : []);

const rangeInput = (field, pick) => {
    const input = element("input", {
        type: "range",
        class: "form-range",
        id: controlId(field),
        min: field.min,
        max: field.max,
        step: field.step,
        title: field.title,
    });
    input.addEventListener("input", () => pick(field, parseFloat(input.value)));
    return input;
};

const renderers = {
    menu(field, pick) {
        const id = controlId(field);
        const stem = kebab(field.setting);
        const attribute = `data-${field.attribute ?? "value"}`;
        const items = field.options.map((option) => {
            const link = element("a", {
                href: "#",
                class: `dropdown-item ${stem}-option`,
                [attribute]: option.value ?? "",
            });
            link.textContent = option.text;
            link.addEventListener("click", (event) => {
                event.preventDefault();
                pick(field, option.value);
            });
            return element("li", {}, link);
        });
        // The space is the one Bootstrap's own markup leaves before the caret.
        const button = element(
            "button",
            {
                type: "button",
                class: "btn btn-secondary dropdown-toggle",
                "data-bs-toggle": "dropdown",
                id,
                title: field.title,
            },
            element("span"),
            " ",
        );
        const menu = element(
            "ul",
            { class: `dropdown-menu dropdown-menu-dark ${stem}-menu`, role: "menu", "aria-labelledby": id },
            ...items,
        );
        const rendered = [row(rowLabel(field), element("div", { class: "col-sm-6 dropdown" }, button, menu))];
        if (field.status) rendered.push(element("div", { id: field.status, class: "mt-2 small text-muted" }));
        return rendered;
    },

    range(field, pick) {
        const control = element("div", { class: "col-sm-6" }, rangeInput(field, pick));
        return [row(rowLabel(field, ...readout(field)), control)];
    },

    group(field, pick) {
        const items = field.fields.map((item) => groupItemRenderers[item.type](item, pick));
        return [row(rowLabel(field), element("div", { class: "col-sm-6" }, ...items))];
    },
};

const groupItemRenderers = {
    check(field, pick) {
        const id = controlId(field);
        const input = element("input", {
            class: "form-check-input",
            type: "checkbox",
            id,
            title: field.title,
        });
        input.addEventListener("click", () => pick(field, input.checked));
        const label = element(
            "label",
            { class: "form-check-label", for: id, title: field.title },
            ...withCode(field.label),
        );
        return element("div", { class: "form-check" }, input, label);
    },

    range(field, pick) {
        const label = element(
            "label",
            { class: "form-check-label", for: controlId(field) },
            ...withCode(field.label),
            ":",
            ...readout(field),
        );
        return element("div", { class: "form-check" }, label, rangeInput(field, pick));
    },
};

/**
 * Builds the form, one element per paragraph. `pick(field, value)` is called with the value the user gives a field;
 * showing it is left to the caller, through showValue.
 *
 * @returns {HTMLElement[]}
 */
export function renderConfigForm(form, pick) {
    return form.map((paragraph) =>
        element(
            "div",
            { class: "config-paragraph" },
            ...paragraph.flatMap((field) => renderers[field.type](field, pick)),
        ),
    );
}

/** Shows `value` in a field's control. */
export function showValue(field, value) {
    const control = document.getElementById(controlId(field));
    switch (field.type) {
        case "menu":
            control.firstChild.textContent = field.describe
                ? field.describe(value)
                : field.options.find((option) => option.value === value).text;
            break;
        case "check":
            control.checked = !!value;
            break;
        case "range":
            control.value = value;
            break;
    }
}
