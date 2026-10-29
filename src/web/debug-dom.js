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
