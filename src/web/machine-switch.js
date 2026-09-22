import { modelSatisfies, satisfiesRequirement } from "./media-catalogue.js";
import { toast } from "./toast.js";
import { noteEvent } from "./analytics.js";

const PendingSwitchKey = "jsbeeb-pending-switch";

// What the page did at startup is not done again on the page switched to; the boot is its own.
const NoStartupActions = {
    autoboot: undefined,
    autochain: undefined,
    autorun: undefined,
    autotype: undefined,
    loadBasic: undefined,
    embedBasic: undefined,
    patch: undefined,
};

/**
 * Moving to the machine a disc needs, which is a page reload: the model and its fitting go in
 * the URL with the disc, and word of the change is stashed for the page that comes up.
 */
export class MachineSwitch {
    constructor({ model, processor, urlState, modals }) {
        this.model = model;
        this.processor = processor;
        this.urlState = urlState;
        this.modals = modals;
    }

    /** Whether the running machine is one the disc runs on, which a disc that names none always is. */
    satisfies(d) {
        return !d.requires || satisfiesRequirement(d.requires, { model: this.model, hasTube: this.processor.hasTube });
    }

    /**
     * Reloads as the machine `d` needs, with `d` in `slot`: without asking when the disc is to
     * boot, since a boot on the wrong machine is no use to anyone, and after a yes otherwise,
     * since the reload throws away whatever the machine was doing.
     * @param {object} options `boot`: the disc is to boot on arrival, so Autoboot goes in the URL;
     *   `replace`: the page switched from was never one to come back to, so it leaves no history
     * @returns {Promise<boolean>} true once the page is on its way; false to load the disc here after all
     */
    async switchFor(d, slot, { boot, replace = false }) {
        const { requires } = d;
        if (!boot) {
            const wanted = await this.modals.confirm(
                `${d.title} needs a ${requires.name}. Switch machine? The emulator restarts.`,
                "Switch machine",
                "Load it here",
            );
            if (!wanted) return false;
        }
        noteEvent("media", "switchMachine", d.ref);
        if (boot) sessionStorage.setItem(PendingSwitchKey, `Switched to a ${requires.name} for ${d.title}`);
        // The requirement is a floor: a model of the right kind and a co-processor already fitted stay.
        const url = this.urlState.urlWith({
            ...slot.urlParamsFor(d.ref),
            ...NoStartupActions,
            ...(modelSatisfies(requires, this.model) ? {} : { model: requires.model }),
            ...(requires.coProcessor ? { coProcessor: true } : {}),
            ...(boot ? { autoboot: true } : {}),
        });
        if (replace) window.location.replace(url);
        else window.location.href = url;
        return true;
    }

    /** Says which machine the last reload switched to, once, on the page it landed on. */
    announce() {
        const notice = sessionStorage.getItem(PendingSwitchKey);
        if (!notice) return;
        sessionStorage.removeItem(PendingSwitchKey);
        toast(notice, { title: "Machine" });
    }
}
