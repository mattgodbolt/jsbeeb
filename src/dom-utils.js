import { replaceOrAddExtension } from "./archive.js";

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
