import {
    AndyView,
    bankName,
    describeBank,
    MainView,
    PagedView,
    peekViewed,
    ShadowView,
    viewDiffers,
    viewedBank,
    viewsFor,
} from "../paging.js";
import { PopupMenu, textButton } from "./dom-utils.js";

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
        floating.panel.querySelector(".panel-title").after(this._picker);
        this._menu = new PopupMenu({
            opener: this._picker,
            className: "paging-menu",
            floating,
            build: () => this._choices(),
        });
    }

    dismissMenu() {
        this._menu.show(false);
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

    /**
     * Whether it shows something at `address` other than what the CPU would read there now; a watch offered there
     * takes no name, as watches read memory as paged.
     */
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
            label: `bank ${bankName(bank)}`,
            contents,
            title: `Sideways bank ${bankName(bank)} at &8000 to &BFFF: ${contents}`,
        };
    }

    /** Shows the view's label again, for what its bank holds now. */
    relabel() {
        if (viewedBank(this._view) !== undefined) this._label();
    }

    _label() {
        const { label, contents, title } = this._describe(this._view);
        const text = contents ? `${label}: ${contents}` : label;
        if (this._picker.textContent === text) return;
        this._picker.textContent = text;
        this._picker.title = `${title}\nClick to show another, or name one in Go to: 8000\`4 or 4:8000`;
        this._picker.classList.toggle("overridden", this._view !== PagedView);
    }

    _choices() {
        return viewsFor(this._cpu.model).map((view) => {
            const { label, contents, title } = this._describe(view);
            const choice = textButton("paging-choice", contents ? `${view.toUpperCase()} ${contents}` : label, title);
            choice.setAttribute("role", "menuitemradio");
            choice.setAttribute("aria-checked", String(view === this._view));
            choice.addEventListener("click", () => {
                this._menu.show(false);
                this.view = view;
            });
            return choice;
        });
    }
}
