import { hexbyte } from "../hex.js";
import {
    AndyView,
    describeBank,
    MainView,
    PagedView,
    peekViewed,
    ShadowView,
    viewDiffers,
    viewedBank,
    viewsFor,
} from "../paging.js";
import { placePopup, popupBehaviour, textButton } from "./dom-utils.js";

const FixedViews = {
    [PagedView]: { label: "paged", title: "Memory as the CPU has it paged now" },
    [AndyView]: { label: "ANDY", title: "The Master's 4K of private RAM, at &8000 to &8FFF" },
    [MainView]: { label: "main RAM", title: "Main RAM at &3000 to &7FFF, whatever ACCCON pages there" },
    [ShadowView]: { label: "shadow RAM", title: "Shadow RAM at &3000 to &7FFF, whatever ACCCON pages there" },
};

/**
 * One panel's choice of which memory it shows where the paging has a choice, picked from a menu by its header's
 * title: what the CPU has paged, or a view of one bank or RAM (see paging.js). It reads through the view without
 * side effects, as peekmem does.
 */
export class PagingOverride {
    /**
     * @param {object} options
     * @param {import("./floating-panel.js").FloatingPanel} options.floating - its panel
     * @param {() => void} options.changed - called once the view has changed
     */
    constructor({ floating, changed }) {
        this._changed = changed;
        this._cpu = null;
        this._view = PagedView;
        this._disassembler = null;
        this._picker = textButton("paging-picker", "", "");
        this._picker.setAttribute("aria-haspopup", "menu");
        this._picker.setAttribute("aria-expanded", "false");
        this._menu = document.createElement("div");
        this._menu.className = "paging-menu";
        this._menu.setAttribute("role", "menu");
        this._menu.hidden = true;
        floating.panel.querySelector(".panel-title").after(this._picker);
        document.body.append(this._menu);
        this._picker.addEventListener("click", () => this._showMenu(this._menu.hidden));
        popupBehaviour(
            this._menu,
            () => (this._menu.hidden ? null : [this._picker, this._menu]),
            () => this.dismissMenu(),
        );
        floating.addEventListener("close", () => this.dismissMenu());
    }

    dismissMenu() {
        this._showMenu(false);
    }

    setCpu(cpu) {
        this._cpu = cpu;
        this._picker.hidden = viewsFor(cpu.model).length === 1;
        this._view = PagedView;
        this._disassembler = null;
        this._label();
    }

    /** @returns {import("../paging.js").PagingView} */
    get view() {
        return this._view;
    }

    set view(view) {
        if (view === this._view) return;
        this._view = view;
        this._disassembler = null;
        this._label();
        this._changed();
    }

    peek(address) {
        return peekViewed(this._cpu, this._view, address);
    }

    /** Whether it shows something at `address` other than what the CPU would read there now. */
    differs(address) {
        return viewDiffers(this._cpu, this._view, address);
    }

    get disassembler() {
        if (!this._disassembler) {
            const { disassembler } = this._cpu;
            this._disassembler =
                this._view === PagedView ? disassembler : disassembler.reading((address) => this.peek(address));
        }
        return this._disassembler;
    }

    _describe(view) {
        const bank = viewedBank(view);
        if (bank === undefined) return FixedViews[view];
        const contents = describeBank(this._cpu, bank);
        return {
            label: `bank ${view.toUpperCase()}`,
            contents,
            title: `Sideways bank ${bank} (&${hexbyte(bank)}) at &8000 to &BFFF: ${contents}`,
        };
    }

    _label() {
        const { label, contents, title } = this._describe(this._view);
        this._picker.textContent = contents ? `${label}: ${contents}` : label;
        this._picker.title = `${title}\nClick to show another, or name one in Go to: 8000\`4 or 4:8000`;
        this._picker.classList.toggle("overridden", this._view !== PagedView);
    }

    _showMenu(show) {
        if (show === !this._menu.hidden) return;
        this._menu.hidden = !show;
        this._picker.setAttribute("aria-expanded", String(show));
        if (!show) return;
        this._menu.replaceChildren(
            ...viewsFor(this._cpu.model).map((view) => {
                const { label, contents, title } = this._describe(view);
                const choice = textButton(
                    "paging-choice",
                    contents ? `${view.toUpperCase()} ${contents}` : label,
                    title,
                );
                choice.setAttribute("role", "menuitemradio");
                choice.setAttribute("aria-checked", String(view === this._view));
                choice.addEventListener("click", () => {
                    this._showMenu(false);
                    this.view = view;
                });
                return choice;
            }),
        );
        const { left, bottom } = this._picker.getBoundingClientRect();
        placePopup(this._menu, left, bottom);
    }
}
