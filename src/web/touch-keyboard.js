import "./touch-keyboard.css";
import { BBC } from "../keymap.js";

const StorageKey = "touchKeyboardOpen";
const NarrowScreenQuery = "(max-width: 700px)";
const TouchQuery = "(pointer: coarse)";
const ForceParameter = "touchkeys";
// The OS scans the keyboard every 10 ms and misses a press shorter than two scans, which a quick tap can be.
const MinHoldMs = 40;
// BREAK resets the machine, which a stray thumb on a phone would do all too easily, so it takes a deliberate hold.
const BreakHoldMs = 350;
// The MOS reads SHIFT (boot) and CTRL (hard reset) just after BREAK is released, so they outlast it.
const ChordHoldMs = 300;
const ShortTapMs = 300;
// A touch in the gap between keys goes to the nearest key if it is within this many CSS pixels of one.
const GapReachPx = 8;
const ModifierKeys = new Set(["SHIFT", "CTRL"]);
const VibrateMs = 8;
const LandscapeQuery = "(max-height: 500px)";
const HeightVariable = "--touch-keyboard-height";
const OpenClass = "touch-keyboard-open";
const HeldClass = "held";
const ShiftedClass = "shifted";

// Safari has no vibrate, which eslint-plugin-compat objects to; the optional call is the guard.
// eslint-disable-next-line compat/compat
const buzz = () => navigator.vibrate?.(VibrateMs);

/**
 * A key on the glass. `key` names a position in the keymap's BBC table, so the press reaches the matrix
 * whatever layout the host is using; `reset` is BREAK, which is not in the matrix. `w` is the flex weight.
 */
const k = (label, key, w = 1, extra = {}) => ({ label, key, w, ...extra });
const letter = (c) => k(c, c);
const fn = (n) => k(`f${n}`, `F${n}`, 1, { cls: "fkey" });
const gap = (w) => ({ spacer: true, w });

const ArrowKeys = [
    k("◀", "LEFT", 0.9, { cls: "arrow" }),
    k("▼", "DOWN", 0.9, { cls: "arrow" }),
    k("▲", "UP", 0.9, { cls: "arrow" }),
    k("▶", "RIGHT", 0.9, { cls: "arrow" }),
];

/** The bottom row is the same on every layer, so a game never has to leave its layer for space or the cursors. */
const BottomRow = (layerLabel) => [
    k(layerLabel, null, 1.6, { cls: "layer" }),
    k("ESC", "ESCAPE", 1.2, { cls: "small" }),
    k("CTRL", "CTRL", 1.2, { cls: "small" }),
    k("SPACE", "SPACE", 3.6),
    ...ArrowKeys,
];

/** The unshifted digit and the shifted symbol the BBC prints above it. */
const DigitLegends = ["1 !", '2 "', "3 #", "4 $", "5 %", "6 &", "7 '", "8 (", "9 )", "0"];
const Digits = DigitLegends.map((legend) => {
    const [digit, sub] = legend.split(" ");
    return k(digit, `K${digit}`, 1, { sub });
});

/** Along the top on every layer, as the red keys are on the real machine, with BREAK apart at the right. */
export const FunctionRow = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(fn),
    gap(0.5),
    k("BREAK", null, 1.6, { cls: "fkey small", reset: true }),
];

const Shift = k("SHIFT", "SHIFT", 1, { cls: "tiny" });
const Delete = k("DEL", "DELETE", 1, { cls: "tiny" });
const Return = k("RET\nURN", "RETURN", 1, { cls: "tiny", rows: 2 });

/**
 * The layers. Every row but the last goes in a 12-column grid (`w` is the columns a key spans, `rows` the rows it
 * spans); the last is the bottom row, in flex weights. The BBC's right-hand cluster (`:` `*`, `/` `?`, RETURN) is
 * on the main layer where it is on the real machine, so a Z X * ? RETURN game plays without switching layer.
 */
export const Layers = {
    letters: [
        [...Digits, k("-", "MINUS", 1, { sub: "=" }), k("^", "HAT_TILDE", 1, { sub: "~" })],
        [...[..."QWERTYUIOP"].map(letter), k("@", "AT"), Return],
        [
            ...[..."ASDFGHJKL"].map(letter),
            k(";", "SEMICOLON_PLUS", 1, { sub: "+" }),
            k(":", "COLON_STAR", 1, { sub: "*" }),
        ],
        [
            Shift,
            ...[..."ZXCVBNM"].map(letter),
            k(",", "COMMA", 1, { sub: "<" }),
            k(".", "PERIOD", 1, { sub: ">" }),
            k("/", "SLASH", 1, { sub: "?" }),
            Delete,
        ],
        BottomRow("more"),
    ],
    symbols: [
        [gap(11), k("\\", "PIPE_BACKSLASH", 1, { sub: "|" })],
        [
            k("TAB", "TAB", 2, { cls: "small" }),
            gap(7),
            k("[", "LEFT_SQUARE_BRACKET", 1, { sub: "{" }),
            k("]", "RIGHT_SQUARE_BRACKET", 1, { sub: "}" }),
            k("\u00a3", "UNDERSCORE_POUND", 1, { sub: "_" }),
        ],
        [k("CAPS", "CAPSLOCK", 2, { cls: "small" }), gap(8), k("RETURN", "RETURN", 2, { cls: "small" })],
        [
            k("SH LK", "SHIFTLOCK", 2, { cls: "small" }),
            k("SHIFT", "SHIFT", 2, { cls: "small" }),
            gap(4),
            k("DEL", "DELETE", 2, { cls: "small" }),
            k("COPY", "COPY", 2, { cls: "small" }),
        ],
        BottomRow("ABC"),
    ],
};

/** Every matrix position a layer can press, for checking the layers against the keymap. */
export const keyNames = () =>
    new Set(
        [FunctionRow, ...Object.values(Layers).flat()]
            .flat()
            .map((key) => key.key)
            .filter(Boolean),
    );

export const matrixPosition = (name) => BBC[name];

/**
 * Whether to offer the keyboard: any touch screen or narrow window, or ?touchkeys to try it at a desk.
 */
export const wantsTouchKeyboard = (search, matches) =>
    new URLSearchParams(search).has(ForceParameter) || matches(TouchQuery) || matches(NarrowScreenQuery);

/**
 * An on-screen BBC keyboard that presses keys in the machine's matrix directly (the same place the physical
 * keyboard's presses end up), so held keys and SHIFT/CTRL chords work with as many fingers as the screen reports.
 */
export class TouchKeyboard {
    constructor({ processor, model, keyboard, layout, loop, onAnyKeyDown }) {
        this.model = model;
        this.onAnyKeyDown = onAnyKeyDown;
        this.processor = processor;
        this.keyboard = keyboard;
        this.layout = layout;
        this.layer = "letters";
        this.held = new Map();
        this.pendingModifierUps = [];
        this.resetActive = false;
        this.resetReleasedAt = -Infinity;
        this.shiftHolds = 0;
        if (!wantsTouchKeyboard(window.location.search, (query) => window.matchMedia(query).matches)) return;

        this.root = this.build();
        document.body.append(this.root);
        this.toggle = this.buildToggle();
        document.body.append(this.toggle);
        window.addEventListener("pointerup", (evt) => this.release(evt));
        window.addEventListener("pointercancel", (evt) => this.release(evt));
        window.addEventListener("blur", () => this.releaseAll());
        loop.addEventListener("tick", () => this.syncLeds());
        new ResizeObserver(() => this.publishHeight()).observe(this.root);
        window.addEventListener("resize", () => this.publishHeight());
        this.setOpen(this.storedOpen());
    }

    storedOpen() {
        try {
            return window.localStorage.getItem(StorageKey) !== "false";
        } catch {
            return true;
        }
    }

    build() {
        const root = document.createElement("div");
        root.id = "touch-keyboard";
        root.dataset.layer = this.layer;
        const bar = document.createElement("div");
        bar.className = "tk-bar";
        bar.append(this.buildMediaButton());
        const hide = document.createElement("button");
        hide.type = "button";
        hide.tabIndex = -1;
        hide.textContent = "⌄ hide";
        hide.addEventListener("click", () => this.setOpen(false));
        bar.append(hide);
        root.append(bar);
        const fixed = document.createElement("div");
        fixed.className = "tk-fixed";
        fixed.append(this.buildRow(FunctionRow));
        root.append(fixed);
        for (const [name, rows] of Object.entries(Layers)) {
            const layer = document.createElement("div");
            layer.className = "tk-layer";
            layer.dataset.name = name;
            const grid = document.createElement("div");
            grid.className = "tk-grid";
            for (const row of rows.slice(0, -1)) for (const def of row) grid.append(this.buildKey(def, true));
            layer.append(grid, this.buildRow(rows.at(-1)));
            root.append(layer);
        }
        root.append(this.buildLeds());
        root.addEventListener("pointerdown", (evt) => this.press(evt));
        for (const type of ["contextmenu", "dblclick", "selectstart", "mousedown"]) {
            root.addEventListener(type, (evt) => evt.preventDefault(), { passive: false });
        }
        return root;
    }

    /** The Model B's three red lights, along the bottom left of its keyboard, each labelled above. */
    buildLeds() {
        const leds = document.createElement("div");
        leds.className = "tk-leds";
        const lights = [
            ["motor", "cassette motor"],
            ...(this.model.isAtom
                ? []
                : [
                      ["caps", "caps lock"],
                      ["shift", "shift lock"],
                  ]),
        ];
        for (const [name, label] of lights) {
            const light = document.createElement("span");
            light.textContent = label;
            const led = document.createElement("i");
            led.dataset.led = name;
            light.append(led);
            leds.append(light);
        }
        return leds;
    }

    /** The hidden lights bar's drive readouts are the way into the media window on a phone. */
    buildMediaButton() {
        const media = document.createElement("button");
        media.type = "button";
        media.tabIndex = -1;
        media.className = "tk-media";
        media.textContent = "media";
        media.addEventListener("click", () => document.querySelector('#leds .slot-readout[data-slot="0"]').click());
        return media;
    }

    /** Follows the same machine state as the lights bar's lamps, which FrontPanel drives from the same fields. */
    syncLeds() {
        if (!this.open) return;
        const { processor } = this;
        const state = {
            motor: processor.tapeInterface.motorOn,
            caps: !this.model.isAtom && processor.sysvia.capsLockLight,
            shift: !this.model.isAtom && processor.sysvia.shiftLockLight,
        };
        for (const led of this.root.querySelectorAll("[data-led]")) {
            led.classList.toggle("on", !!state[led.dataset.led]);
        }
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
        if (def.spacer) return el;
        el.className = `tk-key ${def.cls ?? ""}`;
        // Like the real keycaps: the shifted legend above the unshifted one.
        if (def.sub) {
            const sub = document.createElement("span");
            sub.className = "tk-shifted";
            sub.textContent = def.sub;
            el.append(sub);
        }
        const label = document.createElement("span");
        label.className = "tk-label";
        label.textContent = def.label;
        el.append(label);
        el.dataset.key = def.key ?? "";
        if (def.reset) el.dataset.reset = "1";
        if (def.cls?.includes("layer")) el.dataset.layerKey = "1";
        el.def = def;
        return el;
    }

    buildToggle() {
        const toggle = document.createElement("button");
        toggle.id = "touch-keyboard-toggle";
        toggle.type = "button";
        toggle.tabIndex = -1;
        toggle.textContent = "⌨";
        toggle.setAttribute("aria-label", "Show the on-screen keyboard");
        toggle.addEventListener("click", () => this.setOpen(true));
        return toggle;
    }

    setOpen(open) {
        this.open = open;
        this.root.hidden = !open;
        this.toggle.hidden = open;
        document.body.classList.toggle(OpenClass, open);
        try {
            window.localStorage.setItem(StorageKey, String(open));
        } catch {
            // Remembering is a convenience.
        }
        if (!open) this.releaseAll();
        this.publishHeight();
    }

    publishHeight() {
        // A landscape phone cannot spare the height, so there the keys float translucently over the picture.
        const height = this.open && !window.matchMedia(LandscapeQuery).matches ? this.root.offsetHeight : 0;
        document.documentElement.style.setProperty(HeightVariable, `${height}px`);
        this.layout?.resize();
    }

    setLayer(name) {
        this.layer = name;
        this.root.dataset.layer = name;
    }

    press(evt) {
        if (evt.target.closest("button")) return;
        const el = evt.target.closest(".tk-key") ?? this.nearestKey(evt.clientX, evt.clientY);
        if (!el) return;
        evt.preventDefault();
        if (el.dataset.layerKey) {
            this.setLayer(this.layer === "letters" ? "symbols" : "letters");
            buzz();
            return;
        }
        if (!el.def || this.held.has(evt.pointerId)) return;
        this.onAnyKeyDown();
        el.pressedAt = performance.now();
        this.held.set(evt.pointerId, el);
        el.classList.add(HeldClass);
        if (el.def.reset) {
            // A deliberate chord: with SHIFT or CTRL already down there is no stray touch to guard against.
            if (this.modifierHeld()) this.startReset(el);
            else el.breakTimer = setTimeout(() => this.startReset(el), BreakHoldMs);
        } else {
            this.send(el.def, true);
            if (ModifierKeys.has(el.def.key)) this.startPendingReset();
        }
        this.showShift();
        buzz();
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

    release(evt) {
        const el = this.held.get(evt.pointerId);
        if (!el) return;
        this.held.delete(evt.pointerId);
        el.classList.remove(HeldClass);
        this.letGo(el);
        this.showShift();
    }

    releaseAll() {
        for (const [id, el] of this.held) {
            el.classList.remove(HeldClass);
            this.letGo(el);
            this.held.delete(id);
        }
        this.showShift();
    }

    modifierHeld() {
        return [...this.held.values()].some((el) => ModifierKeys.has(el.def.key));
    }

    startReset(el) {
        el.breakTimer = null;
        this.resetActive = true;
        this.send(el.def, true);
        buzz();
    }

    /** SHIFT or CTRL put down while a lone BREAK is still inside its hold finishes the chord. */
    startPendingReset() {
        for (const el of this.held.values()) {
            if (!el.breakTimer) continue;
            clearTimeout(el.breakTimer);
            this.startReset(el);
        }
    }

    letGo(el) {
        if (el.def.reset) {
            if (el.breakTimer) {
                // Too short to have reset anything; say so rather than feel dead.
                clearTimeout(el.breakTimer);
                el.breakTimer = null;
                el.classList.add("short");
                setTimeout(() => el.classList.remove("short"), ShortTapMs);
                return;
            }
            this.send(el.def, false);
            this.resetActive = false;
            this.resetReleasedAt = performance.now();
            for (const pending of this.pendingModifierUps.splice(0)) this.letGoLater(pending, ChordHoldMs);
            return;
        }
        if (ModifierKeys.has(el.def.key)) {
            // Whichever thumb lifts first, the machine must still see the modifier as BREAK comes up.
            if (this.resetActive) {
                this.pendingModifierUps.push(el);
                return;
            }
            const sinceReset = performance.now() - this.resetReleasedAt;
            if (sinceReset < ChordHoldMs) {
                this.letGoLater(el, ChordHoldMs - sinceReset);
                return;
            }
        }
        this.letGoLater(el, MinHoldMs - (performance.now() - el.pressedAt));
    }

    letGoLater(el, delay) {
        // Pressed again in the meantime, so the key is still wanted down.
        const up = () => {
            if (![...this.held.values()].some((other) => other.def.key === el.def.key)) this.send(el.def, false);
        };
        if (delay > 0) setTimeout(up, delay);
        else up();
    }

    /** Labels show the shifted symbol while any SHIFT key is held. */
    showShift() {
        const shifted = [...this.held.values()].some((el) => el.def.key === "SHIFT");
        this.root.classList.toggle(ShiftedClass, shifted);
    }

    send(def, down) {
        const { input } = this.keyboard;
        if (def.reset) {
            input.setReset(down);
            return;
        }
        const position = this.processor.model.keys[def.key];
        if (input.keyRaw) input.keyRaw(position, down);
        else if (down) this.processor.keyboardInterface.keyDownRaw(position);
        else this.processor.keyboardInterface.keyUpRaw(position);
    }
}
