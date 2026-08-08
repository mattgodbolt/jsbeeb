import * as bootstrap from "bootstrap";

/**
 * Passing notices: something happened that is worth knowing and needs nothing doing about it.
 * The error dialog is for the other kind.
 */

let nextQuietId = 0;

function toastContainer() {
    const existing = document.querySelector(".toast-container");
    if (existing) return existing;
    const container = document.createElement("div");
    container.className = "toast-container position-fixed bottom-0 end-0 p-3";
    document.body.appendChild(container);
    return container;
}

/** @param {string} quietKey */
export function isQuiet(quietKey) {
    return !!window.localStorage[quietKey];
}

/**
 * @param {string} message
 * @param {object} [options]
 * @param {string} [options.title] a heading, for a notice whose message does not say where it came from
 * @param {string} [options.quietKey] offer to stop showing this kind of notice, remembering the answer here
 */
export function toast(message, { title = "", quietKey = "" } = {}) {
    if (quietKey && isQuiet(quietKey)) return;

    const element = document.createElement("div");
    element.className = "toast text-bg-dark";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
    const quietId = `toast-quiet-${nextQuietId++}`;
    element.innerHTML = `
        <div class="toast-header text-bg-dark">
            <strong class="me-auto"></strong>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
        <div class="toast-body">
            <div class="message"></div>
            <div class="form-check mt-2">
                <input class="form-check-input" type="checkbox" id="${quietId}" />
                <label class="form-check-label small" for="${quietId}">Stop telling me this</label>
            </div>
        </div>`;
    // Disc names and the like come from the outside world, so they are set as text, never as markup.
    element.querySelector(".message").textContent = message;
    element.querySelector(".toast-header strong").textContent = title;
    element.querySelector(".toast-header").hidden = !title;

    const quiet = element.querySelector(".form-check");
    quiet.hidden = !quietKey;
    quiet.querySelector("input").addEventListener("change", (event) => {
        if (event.target.checked) window.localStorage[quietKey] = "yes";
        else window.localStorage.removeItem(quietKey);
    });

    toastContainer().appendChild(element);
    element.addEventListener("hidden.bs.toast", () => element.remove());
    bootstrap.Toast.getOrCreateInstance(element).show();
    return element;
}
