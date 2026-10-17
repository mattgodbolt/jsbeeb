import { MaxPersistenceMs } from "./canvas.js";
import { Parameters } from "./parameters.js";

export const PersistenceField = {
    type: "range",
    id: "persistence",
    section: "display",
    label: "Phosphor afterglow",
    readout: (afterglowMs) => (afterglowMs > 0 ? `${afterglowMs} ms` : "none"),
    min: 0,
    max: MaxPersistenceMs,
    step: 5,
    title: "How long the last picture takes to fade under the next, in milliseconds: 0 is no afterglow",
};

/**
 * The Settings dialog's fields, top to bottom, as the parameters declare them, then the afterglow slider, which edits
 * whichever setting the display in use has; an array is a section, set off from what is around it, and a `group` a
 * label beside a column of fields.
 *
 * @returns {Array<object|object[]>}
 */
export function configForm(parameters = Parameters) {
    const fields = Object.entries(parameters)
        .filter(([, { field }]) => field)
        .map(([setting, { field }]) => ({ setting, ...field }));
    const form = [];
    const places = new Map();
    for (const field of [...fields, PersistenceField]) {
        const place = field.group ?? field.section;
        if (place === undefined) {
            form.push(field);
            continue;
        }
        if (!places.has(place)) {
            const container = field.group ? { type: "group", ...field.group, fields: [] } : [];
            places.set(place, container);
            form.push(container);
        }
        const container = places.get(place);
        (Array.isArray(container) ? container : container.fields).push(field);
    }
    return form;
}

/** @returns {object[]} every field in the form that shows a setting, sections and groups flattened. */
export function settingFields(form) {
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

const row = (left, right, className = "row align-items-center") =>
    element("div", { class: className }, element("div", { class: "col-sm-6" }, ...left), right);

const rowLabel = (field, ...extra) =>
    element(
        "label",
        { for: field.type === "group" ? undefined : controlId(field), class: "col-form-label" },
        ...withCode(`${field.label}:`),
        ...extra,
        ...(field.hint ? [element("br"), element("small", {}, ...withCode(field.hint))] : []),
    );

const readout = (field) => (field.readout ? [" ", element("span", { id: readoutId(field) })] : []);

// A field without a setting is wired by whoever owns it, so its input never becomes a pick.
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
    if (field.setting) input.addEventListener("input", () => pick(field, parseFloat(input.value)));
    return input;
};

const checkbox = (field, pick) => {
    const id = controlId(field);
    const input = element("input", { class: "form-check-input", type: "checkbox", id });
    input.addEventListener("click", () => pick(field, input.checked));
    const label = element("label", { class: "form-check-label", for: id }, ...withCode(field.label));
    return element("div", { class: "form-check" }, input, label);
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
            { type: "button", class: "btn btn-secondary dropdown-toggle", "data-bs-toggle": "dropdown", id },
            element("span"),
            " ",
        );
        const menu = element(
            "ul",
            { class: `dropdown-menu dropdown-menu-dark ${stem}-menu`, role: "menu", "aria-labelledby": id },
            ...items,
        );
        const rendered = [row([rowLabel(field)], element("div", { class: "col-sm-6 dropdown" }, button, menu))];
        if (field.status) rendered.push(element("div", { id: field.status, class: "mt-2 small text-muted" }));
        return rendered;
    },

    range(field, pick) {
        return [
            row([rowLabel(field, ...readout(field))], element("div", { class: "col-sm-6" }, rangeInput(field, pick))),
        ];
    },

    check(field, pick) {
        const heading = element("label", { class: "col-form-label" }, `${field.heading}:`);
        const hint = element("div", { class: "small text-muted mt-2" }, ...withCode(field.hint));
        return [row([heading, checkbox(field, pick)], element("div", { class: "col-sm-6" }, hint))];
    },

    group(field, pick) {
        const items = field.fields.map((item) => groupItemRenderers[item.type](item, pick));
        return [row([rowLabel(field)], element("div", { class: "col-sm-6" }, ...items), "row")];
    },
};

const groupItemRenderers = {
    check: checkbox,

    range(field, pick) {
        const label = element(
            "label",
            { class: "form-check-label", for: controlId(field) },
            ...withCode(`${field.label}:`),
            ...readout(field),
        );
        return element("div", { class: "form-check" }, label, rangeInput(field, pick));
    },
};

/**
 * Builds the form, one element per row or section. `pick(field, value)` is called with the value the user gives a
 * field's setting; showing it is left to the caller, through showValue.
 *
 * @returns {HTMLElement[]}
 */
export function renderConfigForm(form, pick) {
    const render = (field) => renderers[field.type](field, pick);
    return form.flatMap((entry) =>
        Array.isArray(entry) ? [element("div", { class: "config-section" }, ...entry.flatMap(render))] : render(entry),
    );
}

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
