import "./touch-keyboard.css";

const StorageKey = "touchKeyboardOpen";
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
const OpenClass = "touch-keyboard-open";
const HeldClass = "held";
const ShiftedClass = "shifted";

// Safari has no vibrate, which eslint-plugin-compat objects to; the optional call is the guard.
// eslint-disable-next-line compat/compat
const buzz = () => navigator.vibrate?.(VibrateMs);

const SvgNs = "http://www.w3.org/2000/svg";
/**
 * Legends Open Gorton cannot set, drawn as the BBC's keycaps print them. The cursor keys' arrow points left, with a
 * solid head over half its length. The function keys' f is a plain f leaning 10 degrees, standing on the
 * baseline, its path in units of a capital's height over 700.
 */
const Glyphs = {
    arrow: { viewBox: "0 0 20 10", path: "M0 5 L11 0 V4.1 H20 V5.9 H11 V10 Z" },
    f: {
        viewBox: "200 0 310 700",
        path: "M490 110 C470 25 372 20 360 110 L262 665 M232 270 H432",
    },
};

const drawGlyph = (name, turn) => {
    const { viewBox, path } = Glyphs[name];
    const svg = document.createElementNS(SvgNs, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("class", `tk-glyph-${name}`);
    if (turn) svg.style.transform = `rotate(${turn}deg)`;
    const pathEl = document.createElementNS(SvgNs, "path");
    pathEl.setAttribute("d", path);
    svg.append(pathEl);
    return svg;
};

/**
 * A key on the glass. `key` names a position in the model's key table, or BREAK; `sub` is the shifted legend the
 * keycap prints above; `glyph` names a drawn legend in place of the text one, turned `turn` degrees clockwise; `digit`
 * follows the legend, small and on its baseline; `w` is the columns the key spans (flex weight outside the grid) and
 * `rows` the rows.
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
        ["←", "LEFT", 0],
        ["↓", "DOWN", 270],
        ["↑", "UP", 90],
        ["→", "RIGHT", 180],
    ].map(([label, key, turn]) => k(label, key, { w: 0.9, cls: "cursor", glyph: "arrow", turn })),
];

export const FunctionRow = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => k("f", `F${n}`, { cls: "fkey", glyph: "f", digit: `${n}` })),
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
        [gap(11), k("\\", "PIPE_BACKSLASH", { sub: "|" })],
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

/** The Model B's lights, along the bottom left of its keyboard. */
const Leds = [
    ["cassette motor", (processor) => processor.tapeInterface.motorOn],
    ["caps lock", (processor) => processor.sysvia.capsLockLight],
    ["shift lock", (processor) => processor.sysvia.shiftLockLight],
];

export const wantsTouchKeyboard = (forced, matches) => forced || matches(TouchQuery) || matches(NarrowScreenQuery);

/**
 * The keys held on the glass and when the machine is told they are up, in the machine's milliseconds. `send(key,
 * down)` presses a key in the matrix, or holds the machine in reset for BREAK.
 */
export class KeyPresses {
    constructor(send) {
        this.send = send;
        /** @type {Map<number, {key: string, pressedAt: number}>} by pointer */
        this.held = new Map();
        /** @type {Map<string, number>} keys lifted from the glass and not yet sent up, by when they went down */
        this.releasing = new Map();
        this.resetting = false;
        this.breakUpAt = -Infinity;
    }

    press(pointerId, key, now) {
        this.held.set(pointerId, { key, pressedAt: now });
        this.sendKey(key, true);
    }

    release(pointerId) {
        const press = this.held.get(pointerId);
        if (!press) return;
        this.held.delete(pointerId);
        this.releasing.set(press.key, press.pressedAt);
    }

    releaseAll() {
        for (const pointerId of [...this.held.keys()]) this.release(pointerId);
    }

    isHeld(key) {
        return [...this.held.values()].some((press) => press.key === key);
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
 * An on-screen BBC keyboard. Keys go to the machine's matrix by position through the same input as the physical
 * keyboard, so held keys and chords work with as many fingers as the screen reports.
 */
export class TouchKeyboard {
    constructor({ processor, model, keyboard, layout, loop, forced, openMedia, onAnyKeyDown }) {
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

        this.root = this.build(openMedia);
        this.toggle = this.buildToggle();
        document.body.append(this.root, this.toggle);
        window.addEventListener("pointerup", (evt) => this.release(evt));
        window.addEventListener("pointercancel", (evt) => this.release(evt));
        window.addEventListener("blur", () => this.releaseAll());
        loop.addEventListener("tick", () => {
            this.presses.sendDueReleases(this.machineMs());
            this.syncLeds();
        });
        this.landscapePhone = window.matchMedia(LandscapePhoneQuery);
        this.landscapePhone.addEventListener("change", () => this.show());
        new ResizeObserver(() => this.show()).observe(this.root);
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
        for (const type of ["contextmenu", "selectstart", "mousedown"]) {
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
        if (def.sub) {
            const sub = document.createElement("span");
            sub.className = "tk-shifted";
            sub.textContent = def.sub;
            el.append(sub);
        }
        const label = document.createElement("span");
        if (def.glyph) label.append(drawGlyph(def.glyph, def.turn));
        else label.textContent = def.label;
        if (def.digit) {
            const digit = document.createElement("span");
            digit.className = "tk-digit";
            digit.textContent = def.digit;
            label.append(digit);
        }
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
        window.localStorage[StorageKey] = String(open);
        this.show();
    }

    /** A landscape phone has no height to spare for the keys, so there the page is as it is without them. */
    show() {
        const landscape = this.landscapePhone.matches;
        const shown = this.open && !landscape;
        this.root.hidden = !shown;
        this.toggle.hidden = this.open || landscape;
        document.body.classList.toggle(OpenClass, shown);
        if (!shown) this.releaseAll();
        this.layout.reserveForTouchKeyboard(shown ? this.root.offsetHeight : null);
    }

    showLayer(name) {
        for (const layer of this.layers) layer.hidden = layer.dataset.name !== name;
    }

    press(evt) {
        if (evt.target.closest("button")) return;
        const el = evt.target.closest(".tk-key") ?? this.nearestKey(evt.clientX, evt.clientY);
        if (!el || this.presses.held.has(evt.pointerId)) return;
        evt.preventDefault();
        const { def } = el;
        if (def.layer) this.showLayer(def.layer);
        else if (this.loop.running) this.presses.press(evt.pointerId, def.key, this.machineMs());
        else return;
        buzz();
        this.onAnyKeyDown();
        this.showHeld();
    }

    /** A touch's pointerdown does not count as a user gesture for starting audio, but its pointerup does. */
    release(evt) {
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
