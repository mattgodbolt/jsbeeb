import { replaceOrAddExtension } from "../archive.js";

export function toggle(el, visible) {
    el.style.display = visible ? "" : "none";
}

export function fadeIn(el, duration = 400) {
    el.style.display = "";
    el.style.transition = `opacity ${duration}ms`;
    el.style.opacity = "0";
    // Force reflow so the transition triggers.
    void el.offsetHeight;
    el.style.opacity = "1";
}

export function fadeOut(el, duration = 400) {
    el.style.transition = `opacity ${duration}ms`;
    el.style.opacity = "0";
    setTimeout(() => {
        if (el.style.opacity === "0") el.style.display = "none";
    }, duration);
}

// Safari fetches the blob a task or more after the click, so the URL must outlive it.
// 40s matches FileSaver.js.
const BlobUrlLifetimeMs = 40000;

/** Save a blob to the user's downloads under the given file name. */
export function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), BlobUrlLifetimeMs);
}

/** Save raw image bytes under the disc's name with the extension of the format they are in. */
export function downloadDriveData(data, name, extension) {
    const blob = new Blob([data], { type: "application/octet-stream" });
    downloadBlob(blob, replaceOrAddExtension(name, extension));
}

/** For text rewritten every frame: a write that changes nothing would still cost the page a layout. */
export function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
}

/** A button drawn as text, out of the tab order, so that Tab from a panel's text box can't reach it. */
export function textButton(className, text, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `txt-btn ${className}`;
    button.textContent = text;
    button.title = title;
    button.tabIndex = -1;
    return button;
}

/**
 * Makes `popup`, fixed on the page outside any panel, a popup: its buttons kept from focus as a panel's are, and
 * `dismiss` called on a pointerdown outside the elements `inside()` lists while it is open (null while closed), or on
 * Escape, which goes no further: not to the machine, nor to a panel.
 * @param {HTMLElement} popup
 * @param {() => (HTMLElement | null)[] | null} inside
 * @param {() => void} dismiss
 */
export function popupBehaviour(popup, inside, dismiss) {
    popup.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) e.preventDefault();
    });
    popup.addEventListener("contextmenu", (e) => e.preventDefault());
    // pointerdown, as a panel's drag handle cancels the mousedown that would follow.
    document.addEventListener(
        "pointerdown",
        (e) => {
            const open = inside();
            if (open && !open.some((element) => element?.contains(e.target))) dismiss();
        },
        true,
    );
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key !== "Escape" || !inside()) return;
            e.preventDefault();
            e.stopPropagation();
            dismiss();
        },
        true,
    );
}

/** Puts a fixed `popup` at `x`, `y` in the window, moved in to fit if it would cross an edge. */
export function placePopup(popup, x, y) {
    popup.style.left = `${Math.max(0, Math.min(x, window.innerWidth - popup.offsetWidth))}px`;
    popup.style.top = `${Math.max(0, Math.min(y, window.innerHeight - popup.offsetHeight))}px`;
}

/**
 * A menu fixed on the page under the button that opens it, or above it when there is no room below, built afresh
 * by `build` each time it opens, and closed as any popup is or when its panel closes.
 */
export class PopupMenu {
    /**
     * @param {object} options
     * @param {HTMLElement} options.opener - the button that opens and closes it
     * @param {string} options.className
     * @param {import("./floating-panel.js").FloatingPanel} options.floating - the panel it belongs to
     * @param {() => HTMLElement[]} options.build - its contents
     */
    constructor({ opener, className, floating, build }) {
        this._opener = opener;
        this._build = build;
        opener.setAttribute("aria-haspopup", "menu");
        opener.setAttribute("aria-expanded", "false");
        this._menu = document.createElement("div");
        this._menu.className = className;
        this._menu.setAttribute("role", "menu");
        this._menu.hidden = true;
        document.body.append(this._menu);
        opener.addEventListener("click", () => this.show(this._menu.hidden));
        popupBehaviour(
            this._menu,
            () => (this._menu.hidden ? null : [opener, this._menu]),
            () => this.show(false),
        );
        floating.addEventListener("close", () => this.show(false));
    }

    show(on) {
        if (on === !this._menu.hidden) return;
        this._menu.hidden = !on;
        this._opener.setAttribute("aria-expanded", String(on));
        if (!on) return;
        this._menu.replaceChildren(...this._build());
        const { left, top, bottom } = this._opener.getBoundingClientRect();
        const height = this._menu.offsetHeight;
        placePopup(this._menu, left, bottom + height <= window.innerHeight ? bottom : top - height);
    }
}
