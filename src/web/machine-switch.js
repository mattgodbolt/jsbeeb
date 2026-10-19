import { requirementName, satisfiesRequirement } from "./media-catalogue.js";
import { toast } from "./toast.js";
import { note } from "./analytics.js";
import { mediaLabel } from "./analytics-filters.js";
import { StartupActionParams } from "./parameters.js";

const PendingSwitchKey = "jsbeeb-pending-switch";

const NoStartupActions = Object.fromEntries(StartupActionParams.map((name) => [name, undefined]));

/**
 * Reloads the page as the machine `params` name (`model`, `coProcessor`), the rest of the URL as
 * `params` say and the page's own startup actions dropped. `replace` leaves no history entry.
 */
export function reloadAsMachine(urlState, params, { replace = false } = {}) {
    const url = urlState.urlWith({ ...NoStartupActions, ...params });
    if (replace) window.location.replace(url);
    else window.location.href = url;
}

/** Leaves `value` under `key` for the page a reload brings up. */
export function leaveForNextPage(key, value) {
    sessionStorage.setItem(key, value);
}

/** Takes what the last page left under `key`, once; null when it left nothing. */
export function takeFromLastPage(key) {
    const value = sessionStorage.getItem(key);
    if (value !== null) sessionStorage.removeItem(key);
    return value;
}

/**
 * Switches to the machine a disc needs by reloading with the model, its co-processor, the fittings
 * it needs and the disc in the URL. The toast for the new page is stashed in sessionStorage until it
 * arrives. `fitted` is the settings the running machine was started with.
 */
export class MachineSwitch {
    constructor({ model, processor, fitted = {}, urlState, modals }) {
        this.model = model;
        this.processor = processor;
        this.fitted = fitted;
        this.urlState = urlState;
        this.modals = modals;
    }

    /** Whether the running machine meets the disc's requirement; a disc without one is always met. */
    satisfies(d) {
        const { model, processor, fitted } = this;
        return !d.requires || satisfiesRequirement(d.requires, { model, hasTube: processor.hasTube, fitted });
    }

    /**
     * Reloads as the machine `d` needs with `d` in `slot`: unasked when the disc is to boot,
     * after a confirm otherwise, since the reload discards the running machine.
     * @param {object} options `boot` puts Autoboot in the URL; `replace` leaves no history entry
     * @returns {Promise<boolean>} true once the reload is under way; false to load the disc here
     */
    async switchFor(d, slot, { boot, replace = false }) {
        const { requires } = d;
        const needed = requirementName(requires, this.model);
        if (!boot) {
            const wanted = await this.modals.confirm(
                `${d.title} needs a ${needed}. Switch machine? The emulator restarts.`,
                "Switch machine",
                "Load it here",
            );
            if (!wanted) return false;
        }
        note("media", { type: "switchMachine", label: mediaLabel(d.ref) });
        if (boot) leaveForNextPage(PendingSwitchKey, `Switched to a ${needed} for ${d.title}`);
        reloadAsMachine(
            this.urlState,
            {
                ...slot.urlParamsFor(d.ref),
                ...(requires.model !== undefined && { model: requires.model, coProcessor: requires.coProcessor }),
                ...requires.fittings,
                ...(boot ? { autoboot: true } : {}),
            },
            { replace },
        );
        return true;
    }

    /** Toasts the switch the last reload made, once. */
    announce() {
        const notice = takeFromLastPage(PendingSwitchKey);
        if (notice === null) return;
        toast(notice, { title: "Machine" });
    }
}
