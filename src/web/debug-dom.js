import { hexword } from "../hex.js";

// The DOM pieces the debugger's views share.

export function labelHtml(addr) {
    return '<span class="addr">' + hexword(addr) + "</span>";
}

export function externalLink(url, text) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = text;
    return link;
}

// Clone a template row, unhide it, append to parent, and remove the template class.
export function cloneTemplate(container) {
    const template = container.querySelector(".template");
    const clone = template.cloneNode(true);
    clone.classList.remove("template");
    clone.style.display = "";
    container.appendChild(clone);
    return clone;
}

/**
 * A view's rows, cloned from its template, as many as fit its height. Its stylesheet sizes it from `--rows`, set here
 * to `initial`, and not from the rows it holds, so that their number never changes its panel's size: the panel being
 * stretched or squeezed changes their number. `refit` redraws them after it has changed.
 */
export class FittedRows {
    /**
     * @param {HTMLElement} container
     * @param {number} initial
     * @param {() => void} refit
     */
    constructor(container, initial, refit) {
        this._container = container;
        this._initial = initial;
        this._template = container.querySelector(".template");
        this._template.remove();
        this._template.classList.remove("template");
        /** @type {HTMLElement[]} */
        this.rows = [];
        container.style.setProperty("--rows", `${initial}`);
        this._setCount(initial);
        new ResizeObserver(([entry]) => {
            const height = entry.contentRect.height;
            const rowHeight = this.rows[0].getBoundingClientRect().height;
            // Both are zero while the panel is hidden.
            if (height === 0 || rowHeight === 0) return;
            const count = Math.max(1, Math.floor(height / rowHeight));
            if (count === this.rows.length) return;
            this._setCount(count);
            refit();
        }).observe(container);
    }

    /**
     * The row a view puts what it centres on in: the middle of as many as it starts with, kept there as more fit
     * below, so that stretching the panel downwards moves nothing already shown.
     */
    get anchor() {
        return Math.floor(Math.min(this._initial, this.rows.length) / 2);
    }

    _setCount(count) {
        while (this.rows.length > count) this.rows.pop().remove();
        while (this.rows.length < count) {
            const row = this._template.cloneNode(true);
            this._container.append(row);
            this.rows.push(row);
        }
    }
}

/**
 * Has a panel's "Go to" box hand `go` the address its text resolves to, marking the box instead when it resolves to
 * none.
 * @param {HTMLFormElement} form
 * @param {(text: string) => number | undefined} resolve
 * @param {(address: number) => void} go
 */
export function bindGotoForm(form, resolve, go) {
    const addr = form.querySelector(".goto-addr");
    addr.addEventListener("input", () => addr.classList.remove("is-invalid"));
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = addr.value.trim();
        if (!text) return;
        const address = resolve(text);
        addr.classList.toggle("is-invalid", address === undefined);
        if (address === undefined) return;
        go(address);
        addr.value = "";
        addr.blur();
    });
}
