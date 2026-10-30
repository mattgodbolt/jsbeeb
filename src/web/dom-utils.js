import { replaceOrAddExtension } from "../archive.js";

// Minimal DOM helpers to replace jQuery usage.

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
