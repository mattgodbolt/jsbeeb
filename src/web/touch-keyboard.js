import "./touch-keyboard.css";
import { navbarHeightOf } from "./floating-panel.js";
import { toast } from "./toast.js";

const StorageKey = "touchKeyboardOpen";
const LayerStorageKey = "touchKeyboardLayer";
const PresetStorageKey = "touchPadPreset";
const NarrowScreenQuery = "(max-width: 700px)";
const TouchQuery = "(pointer: coarse)";
const LandscapePhoneQuery = "(orientation: landscape) and (max-height: 500px)";
// In the machine's own time, which falls behind the wall clock when the page is busy. The OS scans the keyboard every
// 10 ms and misses a press shorter than two scans, and reads SHIFT and CTRL some 20 ms after BREAK comes up.
const MinHoldMs = 40;
const BreakGraceMs = 100;
const BreakModifiers = new Set(["SHIFT", "CTRL"]);
// A touch in the gap between keys goes to the nearest key if it is within this many CSS pixels of one.
const GapReachPx = 8;
const VibrateMs = 8;
const BreakKey = "BREAK";
// The narrowest margin the pad takes beside the picture: room for its d-pad and a strip of four keys.
const PadSidePx = 156;
const OpenClass = "touch-keyboard-open";
const NavbarHiddenClass = "touch-keyboard-navbar-hidden";
const BesidePictureClass = "touch-keyboard-beside-picture";
const LandscapeClass = "landscape";
const OnPadClass = "on-pad";
const HeldClass = "held";
const ShiftedClass = "shifted";

// Safari has no vibrate, which eslint-plugin-compat objects to; the optional call is the guard.
// eslint-disable-next-line compat/compat
const buzz = () => navigator.vibrate?.(VibrateMs);

/**
 * A key on the glass. `key` names a position in the model's key table, or BREAK; `sub` is the shifted legend the
 * keycap prints above; `digit` follows the legend, small and on its baseline; `w` is the columns the key spans (flex
 * weight outside the grid) and `rows` the rows.
 */
const k = (label, key, ...extra) => Object.assign({ label, key, w: 1 }, ...extra);
const letters = (row) => [...row].map((c) => k(c, c));
const gap = (w) => ({ w });
const small = { cls: "small" };

const BottomRow = (layerLabel, layer) => [
    k(layerLabel, null, { w: 1.6, cls: "layer", layer }),
    k("ESC", "ESCAPE", { w: 1.2 }, small),
    k("CTRL", "CTRL", { w: 1.2 }, small),
    k("SPACE", "SPACE", { w: 3.6 }),
    ...[
        ["←", "LEFT"],
        ["↓", "DOWN"],
        ["↑", "UP"],
        ["→", "RIGHT"],
    ].map(([label, key]) => k(label, key, { w: 0.9, cls: "cursor" })),
];

export const FunctionRow = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => k("f", `F${n}`, { cls: "fkey", digit: `${n}` })),
    gap(0.5),
    k("BREAK", BreakKey, { w: 1.6 }, small),
];

/**
 * Every row but the last goes in a 12-column grid; the last is the bottom row, the same on every layer, in flex
 * weights.
 */
export const Layers = {
    main: [
        [
            ...[..."1234567890"].map((digit, i) => k(digit, `K${digit}`, { sub: "!\"#$%&'()"[i] })),
            k("-", "MINUS", { sub: "=" }),
            k("^", "HAT_TILDE", { sub: "~" }),
        ],
        [...letters("QWERTYUIOP"), k("@", "AT"), k("RETURN", "RETURN", { rows: 2, cls: "small vertical" })],
        [...letters("ASDFGHJKL"), k(";", "SEMICOLON_PLUS", { sub: "+" }), k(":", "COLON_STAR", { sub: "*" })],
        [
            k("SHIFT", "SHIFT", { cls: "tiny" }),
            ...letters("ZXCVBNM"),
            k(",", "COMMA", { sub: "<" }),
            k(".", "PERIOD", { sub: ">" }),
            k("/", "SLASH", { sub: "?" }),
            k("DEL", "DELETE", { cls: "tiny" }),
        ],
        BottomRow("more", "more"),
    ],
    more: [
        [k("pad", null, { w: 2, cls: "layer", layer: "pad" }), gap(9), k("\\", "PIPE_BACKSLASH", { sub: "|" })],
        [
            k("TAB", "TAB", { w: 2 }, small),
            gap(7),
            k("[", "LEFT_SQUARE_BRACKET", { sub: "{" }),
            k("]", "RIGHT_SQUARE_BRACKET", { sub: "}" }),
            k("_", "UNDERSCORE_POUND", { sub: "£" }),
        ],
        [k("CAPS", "CAPSLOCK", { w: 2 }, small), gap(8), k("RETURN", "RETURN", { w: 2 }, small)],
        [
            k("SH LK", "SHIFTLOCK", { w: 2 }, small),
            k("SHIFT", "SHIFT", { w: 2 }, small),
            gap(4),
            k("DEL", "DELETE", { w: 2 }, small),
            k("COPY", "COPY", { w: 2, cls: "small cursor" }),
        ],
        BottomRow("ABC", "main"),
    ],
};

const DpadRoles = ["left", "right", "up", "down"];
const DpadArrows = { left: "←", right: "→", up: "↑", down: "↓" };
const move = (keys) => DpadRoles.map((role, i) => ({ key: keys[i], label: role, group: "move", role, use: "core" }));
const core = (key, label, group, role) => ({ key, label, group, role, use: "core" });
const often = (key, label, group) => ({ key, label, group, role: null, use: "often" });

/**
 * Game pad layouts, as data in the shape per-game controls will take: each action names the BBC key it presses, what
 * it does (null where the key's own legend says it), its group and role there, and whether it is in use all the time
 * or often. The pad places them: the move group's directions make the d-pad, fire and second the big buttons, the
 * other core actions a block beside those, and the often ones a strip.
 */
export const PadPresets = {
    classic: {
        title: "classic",
        actions: [
            ...move(["Z", "X", "COLON_STAR", "SLASH"]),
            core("RETURN", null, "buttons", "fire"),
            core("SPACE", null, "buttons", "second"),
        ],
    },
    // Kieran's keys for the Bitshifters ports: 1942, Paradroid, Stryker's Run Redux.
    zxmkl: {
        title: "ZXMKL",
        actions: [
            ...move(["Z", "X", "K", "M"]),
            core("L", "fire", "buttons", "fire"),
            core("SPACE", "action", "buttons", "second"),
            often("RETURN", null, "buttons"),
        ],
    },
    // Superior's Exile (1988), from the action table in Level 7's disassembly.
    exile: {
        title: "Exile",
        actions: [
            ...move(["Q", "W", "P", "L"]),
            core("SPACE", "fire", "buttons", "fire"),
            core("AT", "boost", "buttons", "second"),
            core("O", "aim up", "aim", "up"),
            core("I", "aim mid", "aim", "centre"),
            core("K", "aim low", "aim", "down"),
            core("COMMA", "pick up", "hand", "pick-up"),
            core("M", "drop", "hand", "drop"),
            core("PERIOD", "throw", "hand", "throw"),
            often("S", "store", "pockets"),
            often("G", "get", "pockets"),
            often("TAB", "turn", "body"),
            often("CTRL", "lie", "body"),
            ...["jet", "pistol", "icer", "blast", "plasma", "suit"].map((label, n) => often(`F${n}`, label, "weapons")),
        ],
    },
};

/** The `GP.` URL parameter whose key each of the pad's roles takes, so one remap moves a gamepad and the pad. */
const GamepadControlByRole = { left: "LEFT", right: "RIGHT", up: "UP", down: "DOWN", fire: "FIRE", second: "START" };

/** `preset` with the keys the URL gave a gamepad's directions, FIRE and START in place of its own. */
export function followingGamepad(preset, remapped) {
    const actions = preset.actions.map((action) => {
        const key = remapped[GamepadControlByRole[action.role]];
        return key ? { ...action, key } : action;
    });
    return { ...preset, actions };
}

/**
 * The keys a d-pad presses for a touch at `x`, `y`: its outer thirds are the directions, so a corner presses two.
 * A touch past its edge counts as on the edge, so a thumb that slides off keeps its direction.
 */
export function dpadKeysAt(box, x, y, keyFor) {
    const third = (from, size, at) => Math.min(2, Math.max(0, Math.floor(((at - from) / size) * 3)));
    const column = third(box.left, box.width, x);
    const row = third(box.top, box.height, y);
    const roles = [column === 0 && "left", column === 2 && "right", row === 0 && "up", row === 2 && "down"];
    return roles.filter((role) => role).map((role) => keyFor[role]);
}

/** The Model B's lights, along the bottom left of its keyboard. */
const Leds = [
    ["cassette motor", (processor) => processor.tapeInterface.motorOn],
    ["caps lock", (processor) => processor.sysvia.capsLockLight],
    ["shift lock", (processor) => processor.sysvia.shiftLockLight],
];

const LayerNames = [...Object.keys(Layers), "pad"];
const UprightHint = "Turn the phone upright to type.";

/** What each key's cap says, by the key it presses, for the pad's buttons to say the same. */
const LegendOf = new Map(
    [FunctionRow, ...Object.values(Layers).flat()]
        .flat()
        .filter((def) => def.key)
        .map(({ key, label, sub, digit, cls }) => [key, { label, sub, digit, cls }]),
);

const padKey = (key, meaning, cls) => {
    const legend = LegendOf.get(key) ?? { label: key };
    return k(legend.label, key, legend, { meaning, cls: `${legend.cls ?? ""} ${cls}` });
};

export const wantsTouchKeyboard = (forced, matches) => forced || matches(TouchQuery) || matches(NarrowScreenQuery);

/**
 * The keys held on the glass and when the machine is told they are up, in the machine's milliseconds. `send(key,
 * down)` presses a key in the matrix, or holds the machine in reset for BREAK.
 */
export class KeyPresses {
    constructor(send) {
        this.send = send;
        /** @type {Map<number, Map<string, number>>} by pointer, the keys it holds and when each went down */
        this.held = new Map();
        /** @type {Map<string, number>} keys lifted from the glass and not yet sent up, by when they went down */
        this.releasing = new Map();
        this.resetting = false;
        this.breakUpAt = -Infinity;
    }

    /** Makes `keys` all that a pointer holds, pressing the new ones; true if any was. */
    hold(pointerId, keys, now) {
        const before = this.held.get(pointerId) ?? new Map();
        const after = new Map(keys.map((key) => [key, before.get(key) ?? now]));
        for (const [key, pressedAt] of before) if (!after.has(key)) this.releasing.set(key, pressedAt);
        if (after.size) this.held.set(pointerId, after);
        else this.held.delete(pointerId);
        const pressed = keys.filter((key) => !before.has(key));
        for (const key of pressed) this.sendKey(key, true);
        return pressed.length > 0;
    }

    release(pointerId) {
        this.hold(pointerId, [], null);
    }

    releaseAll() {
        for (const pointerId of [...this.held.keys()]) this.release(pointerId);
    }

    isHeld(key) {
        return [...this.held.values()].some((keys) => keys.has(key));
    }

    /** SHIFT and CTRL stay down until BREAK has been up a while, so SHIFT+BREAK boots whichever thumb lifts first. */
    sendDueReleases(now) {
        const isWithin = (since, ms) => now >= since && now - since < ms;
        for (const [key, pressedAt] of this.releasing) {
            if (this.isHeld(key)) {
                this.releasing.delete(key);
                continue;
            }
            if (isWithin(pressedAt, MinHoldMs)) continue;
            if (BreakModifiers.has(key) && (this.resetting || isWithin(this.breakUpAt, BreakGraceMs))) continue;
            this.releasing.delete(key);
            this.sendKey(key, false);
            if (key === BreakKey) this.breakUpAt = now;
        }
    }

    sendKey(key, down) {
        if (key === BreakKey) this.resetting = down;
        this.send(key, down);
    }
}

/**
 * An on-screen BBC keyboard, and a game pad that a landscape phone shows in the margins beside the picture. Keys go to
 * the machine's matrix by position through the same input as the physical keyboard, so held keys and chords work with
 * as many fingers as the screen reports.
 */
export class TouchKeyboard {
    constructor({ processor, model, keyboard, layout, loop, forced, openMedia, onAnyKeyDown, gamepadRemaps }) {
        if (!wantsTouchKeyboard(forced, (query) => window.matchMedia(query).matches)) return;
        this.processor = processor;
        this.model = model;
        this.layout = layout;
        this.loop = loop;
        this.onAnyKeyDown = onAnyKeyDown;
        this.presses = new KeyPresses((key, down) => {
            const { input } = keyboard;
            if (key === BreakKey) input.setReset(down);
            else input.keyRaw(model.keys[key], down);
        });
        this.presets = { ...PadPresets, classic: followingGamepad(PadPresets.classic, gamepadRemaps) };
        const storedPreset = window.localStorage[PresetStorageKey];
        this.presetName = Object.hasOwn(PadPresets, storedPreset) ? storedPreset : "classic";
        const storedLayer = window.localStorage[LayerStorageKey];
        this.portraitLayer = LayerNames.includes(storedLayer) ? storedLayer : "main";
        /** @type {Set<number>} pointers that went down on the d-pad, whose keys follow them as they slide */
        this.dpadPointers = new Set();
        this.navbarWanted = false;

        this.root = this.build(openMedia);
        this.toggle = this.buildToggle();
        document.body.append(this.root, this.toggle);
        window.addEventListener("pointermove", (evt) => this.slide(evt));
        window.addEventListener("pointerup", (evt) => this.release(evt));
        window.addEventListener("pointercancel", (evt) => this.release(evt));
        window.addEventListener("blur", () => this.releaseAll());
        loop.addEventListener("tick", () => {
            this.presses.sendDueReleases(this.machineMs());
            this.syncLeds();
        });
        this.landscapePhone = window.matchMedia(LandscapePhoneQuery);
        this.landscapePhone.addEventListener("change", () => {
            this.releaseAll();
            this.show();
        });
        new ResizeObserver(() => this.show()).observe(this.root);
        this.setOpen(window.localStorage[StorageKey] !== "false");
    }

    build(openMedia) {
        const root = document.createElement("div");
        root.id = "touch-keyboard";
        const bar = document.createElement("div");
        bar.className = "tk-bar";
        this.presetButton = this.buildButton("", "tk-preset", () => this.nextPreset());
        bar.append(
            this.buildButton("☰ menu", "tk-menu", () => this.toggleNavbar()),
            this.buildButton("media", "tk-media", openMedia),
            this.presetButton,
            this.buildButton("⌄ hide", "tk-hide", () => this.setOpen(false)),
        );
        root.append(bar, this.buildRow(FunctionRow));
        this.layers = Object.entries(Layers).map(([name, rows]) => {
            const layer = document.createElement("div");
            layer.className = "tk-layer";
            layer.dataset.name = name;
            const grid = document.createElement("div");
            grid.className = "tk-grid";
            for (const def of rows.slice(0, -1).flat()) grid.append(this.buildKey(def, true));
            layer.append(grid, this.buildRow(rows.at(-1)));
            return layer;
        });
        this.padLayer = document.createElement("div");
        this.padLayer.className = "tk-layer tk-pad";
        this.padLayer.dataset.name = "pad";
        this.layers.push(this.padLayer);
        this.buildPad();
        root.append(...this.layers, this.buildLeds());
        root.addEventListener("pointerdown", (evt) => this.press(evt));
        for (const type of ["contextmenu", "selectstart", "mousedown"]) {
            root.addEventListener(type, (evt) => evt.preventDefault());
        }
        // iOS ignores a cancelled pointerdown and runs its long-press text selection on the page around the keys.
        root.addEventListener(
            "touchstart",
            (evt) => {
                if (!evt.target.closest("button")) evt.preventDefault();
            },
            { passive: false },
        );
        return root;
    }

    /** The chosen preset's pad: on the left a strip of keys over the d-pad, on the right the digits over the buttons. */
    buildPad() {
        const { title, actions } = this.presets[this.presetName];
        this.presetButton.textContent = `⇄ ${title}`;
        const div = (className, ...children) => {
            const el = document.createElement("div");
            el.className = className;
            el.append(...children);
            return el;
        };
        const keyOf = (action, cls) => this.buildKey(padKey(action.key, action.label, cls), false);
        const moves = actions.filter((action) => action.group === "move");
        const buttons = actions.filter((action) => action.group !== "move" && action.use === "core");
        const big = buttons.filter((action) => action.role === "fire" || action.role === "second");

        const strip = div(
            "tk-pad-strip",
            ...["ESCAPE", "Y", "N"].map((key) => this.buildKey(padKey(key, null, ""), false)),
            this.buildKey(k("ABC", null, { cls: "layer portrait", layer: "main" }), false),
            this.buildKey(k("⌨", null, { cls: "layer landscape", hint: UprightHint }), false),
            ...actions.filter((action) => action.use === "often").map((action) => keyOf(action, "")),
        );
        this.dpadKeys = Object.fromEntries(moves.map((action) => [action.role, action.key]));
        this.dpad = div(
            "tk-dpad",
            ...moves.map((action) =>
                this.buildKey({ ...padKey(action.key, null, action.role), arrow: DpadArrows[action.role] }, false),
            ),
            div("tk-dpad-hub"),
        );
        const digits = div(
            "tk-pad-strip digits",
            ...[..."1234567890"].map((digit) => this.buildKey(padKey(`K${digit}`, null, ""), false)),
        );
        const small = buttons.filter((action) => !big.includes(action));
        this.padLayer.replaceChildren(
            div("tk-pad-side left", strip, div("tk-dpad-room", this.dpad)),
            div(
                "tk-pad-side right",
                digits,
                div("tk-pad-block", ...small.map((action) => keyOf(action, ""))),
                div("tk-pad-fire", ...big.map((action) => keyOf(action, action.role))),
            ),
        );
    }

    nextPreset() {
        const names = Object.keys(this.presets);
        this.presetName = names[(names.indexOf(this.presetName) + 1) % names.length];
        window.localStorage[PresetStorageKey] = this.presetName;
        this.releaseAll();
        this.buildPad();
    }

    toggleNavbar() {
        this.navbarWanted = !this.navbarWanted;
        this.show();
    }

    buildButton(text, className, onClick) {
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.className = className;
        button.textContent = text;
        button.addEventListener("click", onClick);
        return button;
    }

    buildLeds() {
        const leds = document.createElement("div");
        leds.className = "tk-leds";
        this.leds = Leds.map(([label, lit]) => {
            const light = document.createElement("span");
            light.textContent = label;
            const led = document.createElement("i");
            light.append(led);
            leds.append(light);
            return { led, lit };
        });
        const hint = document.createElement("span");
        hint.className = "tk-rotate-hint";
        hint.textContent = "rotate for gamepad";
        hint.hidden = !window.matchMedia(TouchQuery).matches;
        leds.append(hint);
        return leds;
    }

    syncLeds() {
        if (this.root.hidden) return;
        for (const { led, lit } of this.leds) led.classList.toggle("on", !!lit(this.processor));
    }

    buildRow(row) {
        const rowEl = document.createElement("div");
        rowEl.className = "tk-row";
        for (const def of row) rowEl.append(this.buildKey(def, false));
        return rowEl;
    }

    buildKey(def, inGrid) {
        const el = document.createElement("div");
        if (inGrid) {
            el.style.gridColumn = `span ${def.w}`;
            if (def.rows) el.style.gridRow = `span ${def.rows}`;
        } else {
            el.style.flexGrow = def.w;
        }
        if (!def.label) return el;
        el.className = `tk-key ${def.cls ?? ""}`;
        const span = (className, text) => {
            const child = document.createElement("span");
            child.className = className;
            child.textContent = text;
            return child;
        };
        if (def.arrow) el.append(span("tk-arrow", def.arrow));
        if (def.sub) el.append(span("tk-shifted", def.sub));
        const label = span("", def.label);
        if (def.digit) label.append(span("tk-digit", def.digit));
        el.append(label);
        if (def.meaning) {
            el.classList.add("meaning");
            el.append(span("tk-meaning", def.meaning));
        }
        el.def = def;
        return el;
    }

    buildToggle() {
        const toggle = this.buildButton("⌨", "", () => this.setOpen(true));
        toggle.id = "touch-keyboard-toggle";
        toggle.setAttribute("aria-label", "Show the on-screen keyboard");
        return toggle;
    }

    setOpen(open) {
        this.open = open;
        window.localStorage[StorageKey] = String(open);
        this.show();
    }

    /** Upright, the keys go below the picture; a landscape phone has room only beside it, and there shows the pad. */
    show() {
        const landscape = this.landscapePhone.matches;
        const layer = landscape ? "pad" : this.portraitLayer;
        this.root.hidden = !this.open;
        this.toggle.hidden = this.open;
        this.root.classList.toggle(LandscapeClass, landscape);
        this.root.classList.toggle(OnPadClass, layer === "pad");
        for (const el of this.layers) el.hidden = el.dataset.name !== layer;
        document.body.classList.toggle(OpenClass, this.open);
        document.body.classList.toggle(BesidePictureClass, this.open && landscape);
        document.body.classList.toggle(NavbarHiddenClass, this.open && landscape && !this.navbarWanted);
        if (!this.open) {
            this.releaseAll();
            this.layout.reserveForTouchKeyboard(null);
            return;
        }
        this.layout.reserveForTouchKeyboard(
            landscape ? { below: 0, beside: PadSidePx } : { below: this.root.offsetHeight, beside: 0 },
        );
        const side = (window.innerWidth - this.layout.cubMonitor.offsetWidth) / 2;
        this.root.style.setProperty("--tk-side", `${side}px`);
        this.root.style.setProperty("--tk-top", `${navbarHeightOf(document.getElementById("header-bar"))}px`);
    }

    chooseLayer(name) {
        this.portraitLayer = name;
        window.localStorage[LayerStorageKey] = name;
        this.show();
    }

    press(evt) {
        if (evt.target.closest("button")) return;
        if (this.presses.held.has(evt.pointerId) || this.dpadPointers.has(evt.pointerId)) return;
        if (evt.target.closest(".tk-dpad")) {
            evt.preventDefault();
            if (!this.loop.running) return;
            this.dpadPointers.add(evt.pointerId);
            this.slide(evt);
            return;
        }
        const el = evt.target.closest(".tk-key") ?? this.nearestKey(evt.clientX, evt.clientY);
        if (!el) return;
        evt.preventDefault();
        const { def } = el;
        if (def.layer) this.chooseLayer(def.layer);
        else if (def.hint) toast(def.hint);
        else if (this.loop.running) this.presses.hold(evt.pointerId, [def.key], this.machineMs());
        else return;
        buzz();
        this.onAnyKeyDown();
        this.showHeld();
    }

    /** A thumb on the d-pad presses what is under it now, so it can roll from one direction through a diagonal. */
    slide(evt) {
        if (!this.dpadPointers.has(evt.pointerId)) return;
        const keys = dpadKeysAt(this.dpad.getBoundingClientRect(), evt.clientX, evt.clientY, this.dpadKeys);
        const holding = this.presses.held.get(evt.pointerId) ?? new Map();
        if (keys.length === holding.size && keys.every((key) => holding.has(key))) return;
        if (this.presses.hold(evt.pointerId, keys, this.machineMs())) {
            buzz();
            this.onAnyKeyDown();
        }
        this.showHeld();
    }

    /** A touch's pointerdown does not count as a user gesture for starting audio, but its pointerup does. */
    release(evt) {
        this.dpadPointers.delete(evt.pointerId);
        if (!this.presses.held.has(evt.pointerId)) return;
        this.onAnyKeyDown();
        this.presses.release(evt.pointerId);
        this.showHeld();
    }

    /** The key whose face is closest to a touch that landed in a gap, so the gaps are part of the keys. */
    nearestKey(x, y) {
        let nearest = null;
        let nearestDistance = GapReachPx;
        for (const el of this.root.querySelectorAll(".tk-key")) {
            const box = el.getBoundingClientRect();
            if (box.width === 0) continue;
            const distance = Math.hypot(
                Math.max(box.left - x, 0, x - box.right),
                Math.max(box.top - y, 0, y - box.bottom),
            );
            if (distance < nearestDistance) {
                nearest = el;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    releaseAll() {
        this.dpadPointers.clear();
        this.presses.releaseAll();
        this.showHeld();
    }

    /** Lights every key held, and the shifted legends while SHIFT is. */
    showHeld() {
        for (const el of this.root.querySelectorAll(".tk-key")) {
            el.classList.toggle(HeldClass, this.presses.isHeld(el.def.key));
        }
        this.root.classList.toggle(ShiftedClass, this.presses.isHeld("SHIFT"));
    }

    machineMs() {
        const { processor } = this;
        return (processor.cycleSeconds + processor.currentCycles / this.model.cyclesPerSecond) * 1000;
    }
}
