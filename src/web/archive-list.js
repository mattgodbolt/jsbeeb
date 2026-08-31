/** List plumbing every archive picker shares: one modal, one list, one filter box. */

export function clearArchiveList(listId) {
    for (const el of document.querySelectorAll(`#${listId} li:not(.template)`)) el.remove();
}

export function showArchiveMessage(modalId, listId, message) {
    const loading = document.querySelector(`#${modalId} .loading`);
    loading.textContent = message;
    loading.style.display = "";
    clearArchiveList(listId);
}

export function filterArchiveList(listId, filter) {
    filter = filter.toLowerCase();
    for (const el of document.querySelectorAll(`#${listId} li:not(.template)`)) {
        el.style.display = el.textContent.toLowerCase().includes(filter) ? "" : "none";
    }
}

/**
 * Every archive picker offers the same autoboot choice, and it is one setting,
 * so ticking it in either has to show in both.
 */
export class AutobootTicks {
    constructor({ urlState }) {
        this.checks = document.querySelectorAll(".modal .autoboot");
        for (const check of this.checks) {
            check.addEventListener("click", () => {
                this.show(check.checked);
                urlState.set({ autoboot: check.checked ? true : undefined });
            });
        }
    }

    show(checked) {
        for (const check of this.checks) check.checked = checked;
    }
}
