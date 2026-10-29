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

const Digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => k(d, `K${d}`));

/** The two layers, as rows of keys. The first row of each is what is swapped for the other. */
export const Layers = {
    letters: [
        Digits,
        [..."QWERTYUIOP"].map(letter),
        [...[..."ASDFGHJKL"].map(letter), k("RETURN", "RETURN", 1.8, { cls: "small wide" })],
        [
            k("SHIFT", "SHIFT", 1.6, { cls: "small" }),
            ...[..."ZXCVBNM"].map(letter),
            k("DEL", "DELETE", 1.6, { cls: "small" }),
        ],
        BottomRow("@:;"),
    ],
    symbols: [
        [
            ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(fn),
            gap(0.5),
            k("BREAK", null, 1.6, { cls: "fkey small", reset: true }),
        ],
        [
            k("@", "AT"),
            k(":", "COLON_STAR", 1, { sub: "*" }),
            k(";", "SEMICOLON_PLUS", 1, { sub: "+" }),
            k("-", "MINUS", 1, { sub: "=" }),
            k("^", "HAT_TILDE", 1, { sub: "~" }),
            k("\\", "PIPE_BACKSLASH", 1, { sub: "|" }),
            k("[", "LEFT_SQUARE_BRACKET", 1, { sub: "{" }),
            k("]", "RIGHT_SQUARE_BRACKET", 1, { sub: "}" }),
            k("£", "UNDERSCORE_POUND", 1, { sub: "_" }),
            k("/", "SLASH", 1, { sub: "?" }),
        ],
        [
            k(",", "COMMA", 1, { sub: "<" }),
            k(".", "PERIOD", 1, { sub: ">" }),
            k("TAB", "TAB", 1.2, { cls: "small" }),
            k("COPY", "COPY", 1.4, { cls: "small" }),
            gap(1.6),
            k("RETURN", "RETURN", 1.8, { cls: "small wide" }),
        ],
        [
            k("SHIFT", "SHIFT", 1.6, { cls: "small" }),
            k("CAPS", "CAPSLOCK", 1.4, { cls: "small", led: "caps" }),
            k("SH LK", "SHIFTLOCK", 1.4, { cls: "small", led: "shift" }),
            gap(3),
            k("DEL", "DELETE", 1.6, { cls: "small" }),
        ],
        BottomRow("ABC"),
    ],
};

/** Every matrix position a layer can press, for checking the layers against the keymap. */
export const keyNames = () =>
    new Set(
        Object.values(Layers)
            .flat(2)
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
        bar.append(this.buildLeds());
        const hide = document.createElement("button");
        hide.type = "button";
        hide.tabIndex = -1;
        hide.textContent = "⌄ hide";
        hide.addEventListener("click", () => this.setOpen(false));
        bar.append(hide);
        root.append(bar);
        for (const [name, rows] of Object.entries(Layers)) {
            const layer = document.createElement("div");
            layer.className = "tk-layer";
            layer.dataset.name = name;
            for (const row of rows) {
                const rowEl = document.createElement("div");
                rowEl.className = "tk-row";
                for (const def of row) rowEl.append(this.buildKey(def));
                layer.append(rowEl);
            }
            root.append(layer);
        }
        root.addEventListener("pointerdown", (evt) => this.press(evt));
        for (const type of ["contextmenu", "dblclick", "selectstart", "mousedown"]) {
            root.addEventListener(type, (evt) => evt.preventDefault(), { passive: false });
        }
        return root;
    }

    /** The Model B's three red lights, at the left end of the keyboard: cassette motor, caps lock, shift lock. */
    buildLeds() {
        const leds = document.createElement("div");
        leds.className = "tk-leds";
        const lights = [
            ["motor", "tape", "tape"],
            ["disc", "disc", "0"],
            ...(this.model.isAtom
                ? []
                : [
                      ["caps", "caps"],
                      ["shift", "shift"],
                  ]),
        ];
        for (const [name, label, slot] of lights) {
            const light = document.createElement("span");
            if (slot !== undefined) {
                // The hidden lights bar is what opens the media window on a phone, so these labels do it here.
                light.dataset.slot = slot;
                const readout = `#leds .slot-readout[data-slot="${slot}"]`;
                light.addEventListener("click", () => document.querySelector(readout).click());
            }
            light.textContent = label;
            const led = document.createElement("i");
            led.dataset.led = name;
            light.prepend(led);
            leds.append(light);
        }
        return leds;
    }

    /** Follows the same machine state as the lights bar's lamps, which FrontPanel drives from the same fields. */
    syncLeds() {
        if (!this.open) return;
        const { processor } = this;
        const state = {
            motor: processor.tapeInterface.motorOn,
            disc: !this.model.isAtom && (processor.fdc.motorOn[0] || processor.fdc.motorOn[1]),
            caps: !this.model.isAtom && processor.sysvia.capsLockLight,
            shift: !this.model.isAtom && processor.sysvia.shiftLockLight,
        };
        for (const led of this.root.querySelectorAll("[data-led]")) {
            led.classList.toggle("on", !!state[led.dataset.led]);
        }
    }

    buildKey(def) {
        const el = document.createElement("div");
        el.style.flexGrow = def.w;
        if (def.spacer) return el;
        el.className = `tk-key ${def.cls ?? ""}`;
        el.textContent = def.label;
        if (def.sub) {
            const sub = document.createElement("span");
            sub.textContent = def.sub;
            el.append(sub);
        }
        if (def.led) {
            const led = document.createElement("i");
            led.dataset.led = def.led;
            el.prepend(led);
        }
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
        const el = evt.target.closest(".tk-key");
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
            el.breakTimer = setTimeout(() => {
                el.breakTimer = null;
                this.send(el.def, true);
                buzz();
            }, BreakHoldMs);
        } else this.send(el.def, true);
        this.showShift();
        buzz();
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

    letGo(el) {
        if (el.def.reset) {
            // A tap that ends before the hold time never started the reset, so there is nothing to undo.
            if (el.breakTimer) clearTimeout(el.breakTimer);
            else this.send(el.def, false);
            el.breakTimer = null;
            return;
        }
        const remaining = MinHoldMs - (performance.now() - el.pressedAt);
        if (remaining > 0) setTimeout(() => this.send(el.def, false), remaining);
        else this.send(el.def, false);
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
