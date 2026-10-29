import "./touch-keyboard.css";

const StorageKey = "touchKeyboardOpen";
const NarrowScreenQuery = "(max-width: 700px)";
const TouchQuery = "(pointer: coarse)";
const LandscapeQuery = "(max-height: 500px)";
const ForceParameter = "touchkeys";
// In the machine's own time, which falls behind the wall clock when the page is busy. The OS scans the keyboard every
// 10 ms and misses a press shorter than two scans, and reads SHIFT and CTRL some 20 ms after BREAK comes up.
const MinHoldMs = 40;
const BreakGraceMs = 100;
const BreakModifiers = new Set(["SHIFT", "CTRL"]);
// A touch in the gap between keys goes to the nearest key if it is within this many CSS pixels of one.
const GapReachPx = 8;
const VibrateMs = 8;
const BreakKey = "BREAK";
const OpenClass = "touch-keyboard-open";
const HeldClass = "held";
const ShiftedClass = "shifted";

// Safari has no vibrate, which eslint-plugin-compat objects to; the optional call is the guard.
// eslint-disable-next-line compat/compat
const buzz = () => navigator.vibrate?.(VibrateMs);

/**
 * A key on the glass. `key` names a position in the model's key table, or BREAK; `sub` is the shifted legend the
 * keycap prints above; `w` is the columns the key spans (flex weight outside the grid) and `rows` the rows.
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
        ["◀", "LEFT"],
        ["▼", "DOWN"],
        ["▲", "UP"],
        ["▶", "RIGHT"],
    ].map(([label, key]) => k(label, key, { w: 0.9, cls: "arrow" })),
];

export const FunctionRow = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => k(`f${n}`, `F${n}`, { cls: "fkey" })),
    gap(0.5),
    k("BREAK", BreakKey, { w: 1.6, cls: "fkey small" }),
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
        [gap(11), k("\\", "PIPE_BACKSLASH", { sub: "|" })],
        [
            k("TAB", "TAB", { w: 2 }, small),
            gap(7),
            k("[", "LEFT_SQUARE_BRACKET", { sub: "{" }),
            k("]", "RIGHT_SQUARE_BRACKET", { sub: "}" }),
            k("£", "UNDERSCORE_POUND", { sub: "_" }),
        ],
        [k("CAPS", "CAPSLOCK", { w: 2 }, small), gap(8), k("RETURN", "RETURN", { w: 2 }, small)],
        [
            k("SH LK", "SHIFTLOCK", { w: 2 }, small),
            k("SHIFT", "SHIFT", { w: 2 }, small),
            gap(4),
            k("DEL", "DELETE", { w: 2 }, small),
            k("COPY", "COPY", { w: 2 }, small),
        ],
        BottomRow("ABC", "main"),
    ],
};

/** The Model B's lights, along the bottom left of its keyboard. */
const Leds = [
    ["cassette motor", (processor) => processor.tapeInterface.motorOn],
    ["caps lock", (processor) => processor.sysvia.capsLockLight],
    ["shift lock", (processor) => processor.sysvia.shiftLockLight],
];

export const wantsTouchKeyboard = (search, matches) =>
    new URLSearchParams(search).has(ForceParameter) || matches(TouchQuery) || matches(NarrowScreenQuery);

/**
 * An on-screen BBC keyboard. Keys go to the machine's matrix by position through the same input as the physical
 * keyboard, so held keys and chords work with as many fingers as the screen reports.
 */
export class TouchKeyboard {
    constructor({ processor, model, keyboard, layout, loop, openMedia, onAnyKeyDown }) {
        if (model.isAtom || !wantsTouchKeyboard(window.location.search, (query) => window.matchMedia(query).matches))
            return;
        this.processor = processor;
        this.model = model;
        this.keyboard = keyboard;
        this.layout = layout;
        this.onAnyKeyDown = onAnyKeyDown;
        /** @type {Map<number, HTMLElement>} the key each pointer is holding */
        this.held = new Map();
        /** @type {Map<string, number>} keys lifted from the glass and not yet sent up, by when they went down */
        this.releasing = new Map();
        this.resetting = false;
        this.breakUpAt = -Infinity;

        this.root = this.build(openMedia);
        this.toggle = this.buildToggle();
        document.body.append(this.root, this.toggle);
        window.addEventListener("pointerup", (evt) => this.release(evt));
        window.addEventListener("pointercancel", (evt) => this.release(evt));
        window.addEventListener("blur", () => this.releaseAll());
        loop.addEventListener("tick", () => {
            this.sendDueReleases();
            this.syncLeds();
        });
        new ResizeObserver(() => this.reserveRoom()).observe(this.root);
        this.showLayer("main");
        this.setOpen(window.localStorage[StorageKey] !== "false");
    }

    build(openMedia) {
        const root = document.createElement("div");
        root.id = "touch-keyboard";
        const bar = document.createElement("div");
        bar.className = "tk-bar";
        bar.append(
            this.buildButton("media", "tk-media", openMedia),
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
        root.append(...this.layers, this.buildLeds());
        root.addEventListener("pointerdown", (evt) => this.press(evt));
        for (const type of ["contextmenu", "dblclick", "selectstart", "mousedown"]) {
            root.addEventListener(type, (evt) => evt.preventDefault());
        }
        return root;
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
        return leds;
    }

    syncLeds() {
        if (!this.open) return;
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
        if (def.sub) {
            const sub = document.createElement("span");
            sub.className = "tk-shifted";
            sub.textContent = def.sub;
            el.append(sub);
        }
        const label = document.createElement("span");
        label.textContent = def.label;
        el.append(label);
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
        this.root.hidden = !open;
        this.toggle.hidden = open;
        document.body.classList.toggle(OpenClass, open);
        window.localStorage[StorageKey] = String(open);
        if (!open) this.releaseAll();
        this.reserveRoom();
    }

    /** A landscape phone cannot spare the height, so there the keys float translucently over the picture. */
    reserveRoom() {
        const floats = window.matchMedia(LandscapeQuery).matches;
        this.layout.reserveForTouchKeyboard(this.open ? (floats ? 0 : this.root.offsetHeight) : null);
    }

    showLayer(name) {
        for (const layer of this.layers) layer.hidden = layer.dataset.name !== name;
    }

    press(evt) {
        if (evt.target.closest("button")) return;
        const el = evt.target.closest(".tk-key") ?? this.nearestKey(evt.clientX, evt.clientY);
        if (!el || this.held.has(evt.pointerId)) return;
        evt.preventDefault();
        buzz();
        const { def } = el;
        if (def.layer) {
            this.showLayer(def.layer);
            return;
        }
        this.onAnyKeyDown();
        el.pressedAt = this.machineMs();
        this.held.set(evt.pointerId, el);
        el.classList.add(HeldClass);
        this.send(def.key, true);
        this.showShift();
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
        this.letGo(el);
    }

    releaseAll() {
        const els = [...this.held.values()];
        this.held.clear();
        for (const el of els) this.letGo(el);
    }

    letGo(el) {
        el.classList.remove(HeldClass);
        this.showShift();
        this.releasing.set(el.def.key, el.pressedAt);
    }

    /** SHIFT and CTRL stay down until BREAK has been up a while, so SHIFT+BREAK boots whichever thumb lifts first. */
    sendDueReleases() {
        const now = this.machineMs();
        const isWithin = (since, ms) => now >= since && now - since < ms;
        for (const [key, pressedAt] of this.releasing) {
            if (this.isHeld(key)) {
                this.releasing.delete(key);
                continue;
            }
            if (isWithin(pressedAt, MinHoldMs)) continue;
            if (BreakModifiers.has(key) && (this.resetting || isWithin(this.breakUpAt, BreakGraceMs))) continue;
            this.releasing.delete(key);
            this.send(key, false);
            if (key === BreakKey) this.breakUpAt = now;
        }
    }

    machineMs() {
        const { processor } = this;
        return (processor.cycleSeconds + processor.currentCycles / this.model.cyclesPerSecond) * 1000;
    }

    isHeld(key) {
        return [...this.held.values()].some((el) => el.def.key === key);
    }

    showShift() {
        this.root.classList.toggle(ShiftedClass, this.isHeld("SHIFT"));
    }

    send(key, down) {
        const { input } = this.keyboard;
        if (key === BreakKey) {
            this.resetting = down;
            input.setReset(down);
        } else input.keyRaw(this.model.keys[key], down);
    }
}
