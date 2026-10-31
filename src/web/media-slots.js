import { reportLoadFailure } from "./reporting.js";
import { RecentMedia, sourceName } from "./media-catalogue.js";
import { note } from "./analytics.js";
import { mediaLabel, sourceKey } from "./analytics-filters.js";
import { LoadFailures } from "../loader.js";

const DriveNames = ["drive 0", "drive 1"];

const noteLoad = (slot, { source, entry, ref, result }) =>
    note("media_load", { source, kind: slot.kind, slot: slot.id, entry, ref: mediaLabel(ref), result });

/** One place media goes: a drive or the deck. What it holds is read from the machine itself. */
class Slot {
    constructor(slots, kind, index) {
        this.slots = slots;
        this.kind = kind;
        this.index = index;
        this.name = kind === "tape" ? "the deck" : DriveNames[index];
        this.id = kind === "tape" ? "deck" : `drive${index}`;
        /** How the media is known: a URL reference, or a session: reference for a file opened here. */
        this.ref = undefined;
        this.inUrl = false;
        /** The descriptor of the load in flight, and of the load that last failed, for the window. */
        this.busy = null;
        this.failed = null;
        this.claim = null;
    }

    get isDeck() {
        return this.kind === "tape";
    }

    get media() {
        const { processor } = this.slots;
        return this.isDeck ? processor.tapeInterface.tape : processor.fdc.drives[this.index].disc;
    }

    /** The URL parameters that name this slot's media, cleared when it is unnamed or empty. */
    urlParams() {
        return this.urlParamsFor(this.inUrl ? this.ref : undefined);
    }

    /** The URL parameters that would name `ref` as this slot's media. */
    urlParamsFor(ref) {
        if (this.isDeck) return { tape: ref };
        // The URL has always called the drives disc1 and disc2, and a bare disc means disc1.
        return this.index === 0 ? { disc: undefined, disc1: ref } : { disc2: ref };
    }

    /** What the URL names for this slot now, reading a bare disc as disc1. */
    namedInUrl(params) {
        if (this.isDeck) return params.tape;
        return this.index === 0 ? (params.disc1 ?? params.disc) : params.disc2;
    }
}

/**
 * The three slots media goes in: drive 0, drive 1 and the cassette deck. Each slot is the one
 * owner of what it holds, how it is known, the load in flight and the last failure, so every
 * route that changes one (the list, a dropped file, the URL at startup, the desktop menu, a
 * restored state) comes through here and the rest of the page only listens. A load asked for
 * later always wins over one still in flight, whichever finishes first. Raises "changed" with
 * the slot whenever any of that moves.
 */
export class MediaSlots extends EventTarget {
    /**
     * @param {object} deps
     * @param {object} deps.loader fetches a reference into a disc or a tape (loadDiscImage, loadTapeImage)
     * @param {import("./drives.js").Drives} deps.drives
     */
    constructor({ loader, drives, processor, urlState }) {
        super();
        this.loader = loader;
        this.drives = drives;
        this.processor = processor;
        this.urlState = urlState;
        this.recent = new RecentMedia();
        this.driveSlots = [0, 1].map((index) => new Slot(this, "disc", index));
        this.deck = new Slot(this, "tape", 0);
    }

    get all() {
        return [...this.driveSlots, this.deck];
    }

    drive(index) {
        return this.driveSlots[index];
    }

    /** What a slot holds, by the reference it is known by. */
    holding(ref) {
        return this.all.find((slot) => slot.media && slot.ref === ref) ?? null;
    }

    /**
     * Loads a descriptor's media into a slot, reporting a failure on the slot and as a toast.
     * The default fetch resolves the descriptor's reference; `fetch` can make the media some
     * other way (a disc created on Google Drive, say) and name the reference it ends up with.
     *
     * @param {object} [options]
     * @param {Function} [options.fetch] async, returning `{ media, ref }`; a failure of it is not kept for a retry
     * @param {boolean} [options.inUrl] whether the URL names what was loaded; a file opened this session never is
     * @param {boolean} [options.recent] whether it counts as loaded recently; what a page starts with does not
     * @param {string} [options.entry] how the load was asked for: `list`, `recent`, `retry`, `create`, `url`,
     *   `default` or `menu`
     * @returns {Promise<"loaded"|"overtaken"|"failed"|"nothing">}
     */
    async load(slot, descriptor, { entry, ...options } = {}) {
        const { result, ref = descriptor.ref, error } = await this.attempt(slot, descriptor, options);
        const source = ref ? sourceKey(ref) : descriptor.source;
        noteLoad(slot, { source, entry, ref, result });
        if (result === "failed")
            note("load_failed", { source, kind: slot.kind, reason: error?.loadFailure ?? LoadFailures.other });
        return result;
    }

    async attempt(slot, descriptor, { fetch, inUrl, recent = true }) {
        const claim = (slot.claim = {});
        slot.busy = descriptor;
        slot.failed = null;
        this.changed(slot);
        try {
            const { media, ref = descriptor.ref } = await (fetch ?? (() => this.fetchDefault(slot, descriptor)))();
            if (slot.claim !== claim) return { result: "overtaken", ref };
            if (!media) {
                slot.busy = null;
                this.changed(slot);
                return { result: "nothing", ref };
            }
            this.install(slot, media, ref, inUrl ?? descriptor.source !== "session", recent);
            return { result: "loaded", ref };
        } catch (error) {
            if (slot.claim !== claim) return { result: "overtaken" };
            slot.busy = null;
            if (!fetch) slot.failed = { descriptor, error };
            reportLoadFailure(`${descriptor.title} from ${sourceName(descriptor.source)}`, error);
            this.changed(slot);
            return { result: "failed", error };
        }
    }

    async fetchDefault(slot, descriptor) {
        const media = slot.isDeck
            ? await this.loader.loadTapeImage(descriptor.ref)
            : await this.loader.loadDiscImage(descriptor.ref, this.drives.layoutForDrive(slot.index));
        return { media };
    }

    /**
     * Media that is already to hand goes straight in, overtaking any load still in flight.
     *
     * @param {object} [options]
     * @param {boolean} [options.recent] whether it counts as loaded recently; a restored state's media does not
     * @param {string} [options.entry] how it was asked for: `drop`, `file` or `restore`
     */
    put(slot, media, ref, { inUrl = true, recent = true, entry } = {}) {
        slot.claim = {};
        this.install(slot, media, ref, inUrl, recent);
        noteLoad(slot, { source: ref && sourceKey(ref), entry, ref, result: "loaded" });
    }

    eject(slot) {
        slot.claim = {};
        this.install(slot, undefined, undefined, true);
    }

    install(slot, media, ref, inUrl, recent = true) {
        slot.busy = null;
        slot.failed = null;
        this.processor.inputLog?.refuse(slot.isDeck ? "a tape change" : `a disc change in drive ${slot.index}`);
        if (slot.isDeck) this.processor.tapeInterface.setTape(media);
        else if (media) this.drives.putDiscIn(slot.index, media);
        else this.drives.eject(slot.index);
        slot.ref = media ? ref : undefined;
        slot.inUrl = inUrl;
        if (recent && slot.ref) this.recent.note(slot.ref, slot.kind);
        // A URL that already says as much is left alone, so a load it asked for makes no history.
        const named = inUrl ? slot.ref : undefined;
        if (slot.namedInUrl(this.urlState.params) !== named) this.urlState.set(slot.urlParams());
        this.changed(slot);
    }

    /** A restored state has put the machine's side of every slot back, behind the slots' backs. */
    restored() {
        for (const slot of this.driveSlots) this.drives.followRestoredPitch(slot.index);
        for (const slot of this.all) this.changed(slot);
    }

    changed(slot) {
        this.dispatchEvent(new CustomEvent("changed", { detail: { slot } }));
    }
}
