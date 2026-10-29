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

/** In px, a shortfall that layout rounding can leave, and that still counts as fitting. */
const RoundingSlack = 0.5;

/** How many rows of `rowHeight` fit in `height`, at least one. */
export function rowsThatFit(height, rowHeight) {
    return Math.max(1, Math.floor((height + RoundingSlack) / rowHeight));
}

/** The most columns, a power of two and at least `fewest`, of `columnWidth` each that fit beside `fixed` in `width`. */
export function powerOfTwoColumnsThatFit(width, fixed, columnWidth, fewest) {
    let count = fewest;
    while (fixed + 2 * count * columnWidth <= width + RoundingSlack) count *= 2;
    return count;
}

/**
 * The rows of a view's container, cloned from its template, as many as fit the container's height. The stylesheet
 * sizes the container from `--rows`, set here to `initial`, and not from the rows in it, so that their number never
 * changes the panel's size: the panel being stretched or squeezed changes their number. `refit` redraws them after
 * it has changed.
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
            const count = rowsThatFit(height, rowHeight);
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
 * Has a panel's "Go to" box hand `go` what its text resolves to, marking the box instead when it resolves to nothing.
 * @template Target
 * @param {HTMLFormElement} form
 * @param {(text: string) => Target | undefined} resolve
 * @param {(target: Target) => void} go
 */
export function bindGotoForm(form, resolve, go) {
    const addr = form.querySelector(".goto-addr");
    addr.addEventListener("input", () => addr.classList.remove("is-invalid"));
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = addr.value.trim();
        if (!text) return;
        const target = resolve(text);
        addr.classList.toggle("is-invalid", target === undefined);
        if (target === undefined) return;
        go(target);
        addr.value = "";
        addr.blur();
    });
}
