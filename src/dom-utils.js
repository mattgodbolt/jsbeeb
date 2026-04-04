"use strict";

// Minimal DOM helpers to replace jQuery usage.

export function show(el) {
    el.style.display = "";
}

export function hide(el) {
    el.style.display = "none";
}

export function toggle(el, visible) {
    el.style.display = visible ? "" : "none";
}

export function fadeIn(el, duration = 400) {
    el.style.display = "";
    el.style.transition = `opacity ${duration}ms`;
    el.style.opacity = "0";
    // Force reflow so the transition triggers.
    el.offsetHeight;
    el.style.opacity = "1";
}

export function fadeOut(el, duration = 400) {
    el.style.transition = `opacity ${duration}ms`;
    el.style.opacity = "0";
    setTimeout(() => {
        if (el.style.opacity === "0") el.style.display = "none";
    }, duration);
}
