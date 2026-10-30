import { dfsCatalogue } from "../disc.js";
import { replaceOrAddExtension } from "../archive.js";
import { FloatingPanel } from "./floating-panel.js";
import { Centred, EndEdge } from "./panel-layout.js";
import { tracksLabel, tracksPerStepOf } from "./drives.js";
import {
    Sources,
    compareForQuery,
    describeBrowserDisc,
    matchesQuery,
    sourceName,
    sourceOf,
} from "./media-catalogue.js";
import { errorText, reportLoadFailure } from "./reporting.js";
import { guessDiscTypeFromName } from "../fdc.js";
import { toast } from "./toast.js";
import { noteFeature } from "./analytics.js";

const MinPanelSize = { w: 420, h: 240 };

const CounterDigits = 3;
const CounterDivisions = 10 ** CounterDigits;

// Beyond this the list is a scroll nobody reads; the search box narrows it.
const MaxRows = 100;

// How long the search box stays highlighted where motion is off, and a backstop where it is on.
const NudgeMs = 2000;
// The drive almost nobody uses, folded to one line until it holds something or is aimed at.
const FoldableDrive = 1;

const targetFrom = (slot) => (slot === "tape" ? "tape" : Number(slot));

/**
 * What a disc going into `driveIndex` does. Only drive 0 boots: as the Autoboot tick says, the other way
 * with Shift, or as `boot` says whatever the tick. `urlAutoboot` is what the URL's autoboot becomes,
 * undefined to leave it alone; it says the load booted only where the URL names the disc (`inUrl`).
 */
export function bootDecision({ driveIndex, ticked, shift = false, boot, inUrl = false }) {
    if (driveIndex !== 0) return { boots: false, urlAutoboot: undefined };
    const boots = boot ?? shift !== ticked;
    return { boots, urlAutoboot: boots && inUrl };
}

/** The keys that load from the search box, and what they do, aimed at `target`. */
function hintKeys(target, ticked) {
    if (target === "tape") return [["Enter", "loads into the deck"]];
    const boots = (shift) => bootDecision({ driveIndex: target, ticked, shift }).boots;
    if (!boots(false) && !boots(true)) return [["Enter", `loads into drive ${target}, which does not boot`]];
    return [
        ["Enter", boots(false) ? `boots from drive ${target}` : `loads into drive ${target}`],
        ["Shift+Enter", boots(true) ? "loads and boots" : "loads without booting"],
    ];
}

// What fits on a line of the LED panel: the name without its folder or extension, cut in the
// middle when it is still too long, so both the start and the end of it survive.
const ReadoutChars = 12;
const ReadoutTailChars = 4;
export function shortName(name) {
    const bare = name
        .split("/")
        .pop()
        .replace(/\.[a-z0-9]+$/i, "");
    if (bare.length <= ReadoutChars) return bare;
    return `${bare.slice(0, ReadoutChars - ReadoutTailChars - 1)}…${bare.slice(-ReadoutTailChars)}`;
}
const counterDigits = (count) => String(count).padStart(CounterDigits, "0");
const otherDrive = (driveIndex) => 1 - driveIndex;
// The BBC addresses the other side of a drive's disc as drive N+2.
const upperSideOf = (driveIndex) => driveIndex + 2;

/**
 * The media window: two drive fronts and a cassette deck showing what the
 * machine holds, with the controls that belong on them (eject, the 40/80
 * switch, save, the disc surface, the tape transport); under them one
 * searchable list of everything every source offers; and the one-line
 * readouts in the LED panel that open it.
 */
/** A source's page about an entry, as a URL, if it is one a browser may be sent to; the source is not trusted. */
function webPage(url) {
    if (!url) return null;
    try {
        const page = new URL(url);
        return page.protocol === "https:" || page.protocol === "http:" ? page : null;
    } catch {
        return null;
    }
}

export class MediaWindow {
    constructor({
        media,
        drives,
        processor,
        model,
        loop,
        visualiser,
        autoboot,
        driveSource,
        machineSwitch,
        arrangement,
    }) {
        this.media = media;
        this.slots = media.slots;
        this.drives = drives;
        this.processor = processor;
        this.model = model;
        this.visualiser = visualiser;
        this.autoboot = autoboot;
        this.driveSource = driveSource;
        this.machineSwitch = machineSwitch;

        this.panel = document.getElementById("media-panel");
        this.floating = new FloatingPanel({
            panel: this.panel,
            id: "media",
            title: null,
            menuGroup: null,
            group: null,
            place: () => ({ x: Centred, y: EndEdge }),
            minSize: MinPanelSize,
            reopens: false,
            arrangement,
        });
        this.summary = document.getElementById("media-summary");
        this.bays = [0, 1].map((driveIndex) => this.buildBay(driveIndex));
        this.deck = this.buildDeck();
        this.list = this.buildList();
        this.readouts = Object.fromEntries(
            [...document.querySelectorAll("#leds .slot-readout")].map((el) => [el.dataset.slot, el]),
        );
        this.counterBase = 0;
        this.lastCounter = null;
        this.target = 0;
        this.asked = [null, null];

        for (const opener of document.querySelectorAll(".media-window-open"))
            opener.addEventListener("click", (e) => {
                e.preventDefault();
                const { slot } = opener.dataset;
                if (slot === undefined) this.open();
                else this.openFor(targetFrom(slot));
            });
        this.floating.addEventListener("open", () => {
            this.list.searchNoted = false;
            this.refreshList();
        });
        this.floating.addEventListener("close", () => (this.list.newDiscForm.hidden = true));
        // A slot that gains something unfolds; the rows say which slot holds them.
        this.slots.addEventListener("changed", (e) => {
            const { slot } = e.detail;
            if (slot.isDeck) {
                if (slot.media !== this.deck.shown) this.counterBase = 0;
                this.deck.shown = slot.media;
                if (slot.media) this.showDeck(true);
                this.renderDeck();
            } else {
                if (slot.media && slot.index === FoldableDrive) this.showDrive(true);
                this.renderDrive(slot.index);
                this.visualiser.redraw();
            }
            this.renderList();
        });
        drives.addEventListener("tracks-changed", (e) => this.renderDrive(e.detail.driveIndex));
        // A file opened while the window is up joins the list; closed, the next open lists it anyway.
        media.addEventListener("files-changed", () => {
            if (this.isOpen) this.refreshList();
        });
        loop.addEventListener("tick", () => this.tick());
        this.pageListeners = new AbortController();
        this.bindDropZone();
        // The Atom has no disc drives: only the deck, and only the deck to aim at.
        if (model.isAtom) {
            this.panel.querySelector(".media-case").hidden = true;
            for (const button of this.list.into.querySelectorAll('[data-target]:not([data-target="tape"])'))
                button.hidden = true;
        }
        this.showDeck(model.isAtom);
        this.showDrive(false);
        this.showList(true);
        this.setTarget(this.defaultTarget);
        this.renderAll();
    }

    get defaultTarget() {
        return this.model.isAtom ? "tape" : 0;
    }

    /** What the machine can take: a machine without drives is offered no discs. */
    get kindsOffered() {
        return this.processor.fdc ? ["disc", "tape"] : ["tape"];
    }

    get isOpen() {
        return this.floating.isOpen;
    }

    /**
     * The whole page takes a dropped file: a disc goes into the aimed drive, a tape into the
     * deck, a save state is restored. An overlay says so while a file is over the page. An element
     * with `data-drop-into` takes its own drops, and the overlay says what it does with them.
     */
    bindDropZone() {
        const zone = document.getElementById("drop-zone");
        const what = zone.querySelector(".drop-zone-what");
        const words = zone.querySelector(".drop-zone-into");
        const ownWhat = what.textContent;
        const claimant = (e) => (e.target instanceof Element ? e.target.closest("[data-drop-into]") : null);
        const describe = (e) => {
            const claimed = claimant(e);
            what.textContent = claimed?.dataset.dropWhat ?? ownWhat;
            words.textContent =
                claimed?.dataset.dropInto ??
                (this.model.isAtom ? "a tape goes in the deck" : `a disc goes into ${this.targetName}`);
        };
        // dragenter and dragleave fire for every element crossed, so the depth says when the page is left.
        let depth = 0;
        const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
        const { signal } = this.pageListeners;
        document.addEventListener(
            "dragenter",
            (e) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                if (depth++ === 0) zone.hidden = false;
                describe(e);
            },
            { signal },
        );
        document.addEventListener(
            "dragover",
            (e) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                describe(e);
            },
            { signal },
        );
        document.addEventListener(
            "dragleave",
            (e) => {
                if (!hasFiles(e)) return;
                if (--depth === 0) zone.hidden = true;
            },
            { signal },
        );
        document.addEventListener(
            "drop",
            async (e) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                depth = 0;
                zone.hidden = true;
                if (claimant(e)) return;
                const file = e.dataTransfer.files[0];
                if (!file) return;
                await this.openFile(file, "Dropped", "drop");
            },
            { signal },
        );
    }

    /** Takes the window's drop-zone listeners off the page, for a page that builds another window. */
    dispose() {
        this.pageListeners.abort();
    }

    /** Where a disc from this computer goes, in words. */
    get targetName() {
        return `drive ${this.targetDrive}`;
    }

    /**
     * Opens a file from this computer into the aimed drive, the deck or the machine's state, says
     * so, boots a disc that went into drive 0 if Autoboot is ticked, and gets out of the way.
     */
    async openFile(file, title, entry) {
        try {
            const opened = await this.media.openFile(file, this.targetDrive, entry);
            if (!opened) return;
            toast(opened.words, { title });
            if (opened.kind === "disc") this.loaded(opened.driveIndex);
            this.close();
        } catch (error) {
            reportLoadFailure(file.name, error);
        }
    }

    /** Opens with the list, aimed at drive 0 (the deck, on the Atom). */
    open() {
        this.setTarget(this.defaultTarget);
        this.showList(true);
        this.floating.open();
        this.list.search.select();
        this.list.search.focus();
    }

    /** Opens from a slot's own line, aimed at that slot. */
    openFor(target) {
        this.floating.open();
        this.aimAt(this.model.isAtom ? "tape" : target);
    }

    close() {
        this.floating.close();
    }

    buildBay(driveIndex) {
        const template = document.getElementById("drive-bay-template");
        const section = template.content.firstElementChild.cloneNode(true);
        this.panel.querySelector(".bays").appendChild(section);
        const upperSide = upperSideOf(driveIndex);
        section.dataset.drive = driveIndex;
        section.setAttribute("aria-label", `Drive ${driveIndex}`);
        section.querySelector(".bay-number").textContent = `${driveIndex}/${upperSide}`;
        section.querySelector(".bay-badge").title =
            `Drive ${driveIndex}; the BBC calls the other side of its disc drive ${upperSide}`;
        section.querySelector(".bay-pitch-legend").textContent = `Drive ${driveIndex} reads`;
        section.querySelector(".bay-led").setAttribute("aria-label", `Drive ${driveIndex} idle`);
        const pitch = section.querySelector(".pitch");
        pitch.title = `Drive ${driveIndex}'s 40/80 track switch`;
        for (const radio of pitch.querySelectorAll("input")) {
            radio.name = `pitch-${driveIndex}`;
            radio.setAttribute("aria-label", `${radio.value} track`);
            radio.closest("label").title = `Drive ${driveIndex} reads ${radio.value} track discs`;
            radio.addEventListener("change", () =>
                this.drives.setTracksPerStep(driveIndex, tracksPerStepOf(radio.value)),
            );
        }
        // The knob's track is a switch too: a click throws it the other way.
        pitch.querySelector(".track").addEventListener("click", () => {
            const other = [...pitch.querySelectorAll("input")].find((radio) => !radio.checked);
            if (!other || other.disabled) return;
            other.checked = true;
            other.dispatchEvent(new Event("change"));
        });
        const bay = {
            driveIndex,
            section,
            led: section.querySelector(".bay-led"),
            eject: section.querySelector(".bay-eject"),
            slot: section.querySelector(".bay-slot"),
            title: section.querySelector(".bay-title"),
            dfs: section.querySelector(".bay-dfs"),
            sub: section.querySelector(".bay-sub"),
            status: section.querySelector(".bay-status"),
            kept: section.querySelector(".bay-kept"),
            fail: section.querySelector(".bay-fail"),
            retry: section.querySelector(".bay-retry"),
            hide: section.querySelector(".bay-hide"),
            save: section.querySelector(".bay-save"),
            surface: section.querySelector(".bay-surface"),
            report: section.querySelector(".bay-report"),
            notes: section.querySelector(".bay-notes"),
            radios: [...pitch.querySelectorAll("input")],
            watched: null,
            onTrackWrite: (isSideUpper, trackNum) => {
                if (!isSideUpper && trackNum === 0) this.showSticker(bay);
            },
        };
        // The latch ejects a disc, and on an empty drive it is where you would put one in.
        bay.eject.addEventListener("click", () => {
            const slot = this.slots.drive(driveIndex);
            if (slot.media) this.slots.eject(slot);
            else this.aimAt(driveIndex);
        });
        bay.slot.addEventListener("click", () => this.aimAt(driveIndex));
        const bar = section.querySelector(".bay-bar");
        bar.querySelector(".bay-bar-label").textContent = `drive ${driveIndex}/${upperSide}`;
        bar.title = `Show drive ${driveIndex}`;
        bar.addEventListener("click", () => this.showDrive(true));
        bay.bar = bar;
        bay.barName = bar.querySelector(".bay-bar-name");
        bay.hide.title = `Fold drive ${driveIndex} away`;
        bay.hide.addEventListener("click", () => this.showDrive(false));
        bay.retry.addEventListener("click", () =>
            this.loadDisc(driveIndex, this.slots.drive(driveIndex).failed.descriptor, {
                ...this.askedOf(driveIndex),
                entry: "retry",
            }),
        );
        section
            .querySelector(".bay-save-ssd")
            .addEventListener("click", () => this.drives.downloadSsdOrDsd(driveIndex));
        section.querySelector(".bay-save-hfe").addEventListener("click", () => this.drives.downloadHfe(driveIndex));
        section.querySelector(".bay-save-drive").addEventListener("click", () => this.offerCopyToDrive(driveIndex));
        bay.save.title = `Download drive ${driveIndex}'s disc as an image`;
        bay.surface.title = `Open the disc surface window on drive ${driveIndex}`;
        bay.surface.addEventListener("click", () => this.visualiser.openOn(driveIndex));
        bay.report.title = `Open the disc surface window on drive ${driveIndex}, listing what is odd about the disc`;
        bay.report.addEventListener("click", () => this.visualiser.openReport(driveIndex));
        return bay;
    }

    buildDeck() {
        const deck = {
            section: document.getElementById("media-deck"),
            data: document.getElementById("deck-data"),
            counter: document.getElementById("tape-counter"),
            window: document.getElementById("deck-window"),
            cassette: document.getElementById("deck-cassette"),
            empty: document.getElementById("deck-empty"),
            title: document.getElementById("deck-tape-title"),
            sub: document.getElementById("deck-tape-sub"),
            status: document.getElementById("deck-status"),
            fail: document.getElementById("deck-fail"),
            retry: document.getElementById("deck-retry"),
            rewind: document.getElementById("tape-rewind"),
            play: document.getElementById("tape-play"),
            stop: document.getElementById("tape-stop"),
            eject: document.getElementById("tape-eject"),
            barName: document.getElementById("deck-bar-name"),
            bar: document.getElementById("deck-toggle"),
            hide: document.getElementById("deck-hide"),
            shown: undefined,
        };
        deck.window.addEventListener("click", () => this.aimAt("tape"));
        deck.eject.addEventListener("click", () => this.slots.eject(this.slots.deck));
        deck.retry.addEventListener("click", () =>
            this.loadTape(this.slots.deck.failed.descriptor, { entry: "retry" }),
        );
        deck.rewind.addEventListener("click", () => {
            this.processor.tapeInterface.rewindTape();
            this.renderDeck();
        });
        deck.play.addEventListener("click", () => {
            this.processor.tapeInterface.pressPlay();
            this.renderDeck();
        });
        deck.stop.addEventListener("click", () => {
            this.processor.tapeInterface.pressStop();
            this.renderDeck();
        });
        deck.bar.addEventListener("click", () => this.showDeck(true));
        deck.hide.addEventListener("click", () => this.showDeck(false));
        document.getElementById("tape-counter-reset").addEventListener("click", () => {
            this.counterBase = this.tapeCount();
            this.showCounter();
        });
        return deck;
    }

    buildList() {
        const list = {
            search: document.getElementById("media-search"),
            count: document.getElementById("media-count"),
            chips: document.getElementById("media-chips"),
            rows: document.getElementById("media-list"),
            open: document.getElementById("media-open"),
            openText: document.getElementById("media-open-text"),
            openLabel: document.getElementById("media-open-label"),
            into: document.getElementById("media-into"),
            hint: document.getElementById("media-hint"),
            bar: document.getElementById("list-toggle"),
            hide: document.getElementById("list-hide"),
            newDiscLabel: document.getElementById("media-new-disc-label"),
            newDiscWhere: document.getElementById("media-new-disc-where"),
            copyFrom: null,
            autoboot: this.panel.querySelector(".autoboot"),
            newDisc: document.getElementById("media-new-disc"),
            newDiscForm: document.getElementById("media-new-disc-form"),
            newDiscName: document.getElementById("media-new-disc-name"),
            newDiscDriveOption: document.getElementById("media-new-disc-drive-option"),
            connect: document.getElementById("media-connect-drive"),
            descriptors: [],
            failures: [],
            latest: null,
            query: "",
            searchNoted: false,
            source: "all",
            kinds: { disc: true, tape: true },
            loaded: false,
        };
        list.search.addEventListener("input", () => {
            list.query = list.search.value.trim();
            if (list.query && !list.searchNoted) {
                list.searchNoted = true;
                noteFeature(this.panel, "search");
            }
            this.renderList();
        });
        // Enter takes the first match; the arrows walk the rows and come back to the box.
        list.search.addEventListener("keydown", (e) => {
            const first = list.rows.querySelector(".media-row-main");
            if (e.key === "Enter" && first) {
                e.preventDefault();
                this.loadInto(this.rowTarget(first.descriptor), first.descriptor, {
                    shift: e.shiftKey,
                    entry: first.entry,
                });
            } else if (e.key === "ArrowDown" && first) {
                e.preventDefault();
                first.focus();
            }
        });
        list.rows.addEventListener("keydown", (e) => {
            const row = e.target.closest(".media-row");
            if (!row) return;
            const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const rows = [...list.rows.querySelectorAll(".media-row")];
            const next = rows[rows.indexOf(row) + step];
            if (next) next.querySelector(".media-row-main").focus();
            else if (step < 0) list.search.focus();
        });
        list.open.addEventListener("change", async (evt) => {
            const file = evt.target.files[0];
            if (!file) return;
            await this.openFile(file, "Opened", "file");
            evt.target.value = "";
        });
        list.connect.addEventListener("click", async () => {
            if (await this.driveSource.connect()) this.loadDriveDiscs();
        });
        list.autoboot.checked = true;
        list.autoboot.addEventListener("change", () => this.renderList());
        list.newDisc.addEventListener("click", () => this.showDiscForm({ copyFrom: null }));
        document.getElementById("media-new-disc-cancel").addEventListener("click", () => {
            list.newDiscForm.hidden = true;
            list.search.focus();
        });
        list.newDiscForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const where = list.newDiscForm.querySelector('input[name="media-new-disc-where"]:checked').value;
            this.createDisc(list.newDiscName.value.trim(), where);
        });
        list.bar.addEventListener("click", () => {
            this.showList(true);
            this.list.search.focus();
        });
        list.hide.addEventListener("click", () => this.showList(false));
        for (const button of list.into.querySelectorAll("[data-target]"))
            button.addEventListener("click", () => this.aimAt(targetFrom(button.dataset.target)));
        return list;
    }

    /** Points the list at a slot, unfolded and ready to type into: what Enter on a row loads into. */
    aimAt(target) {
        this.unfold(target);
        this.setTarget(target);
        this.showList(true);
        this.list.search.select();
        this.list.search.focus();
        this.nudgeSearch();
    }

    /** Draws the eye to the search box, which is where a slot's "load one" leads. */
    nudgeSearch() {
        const box = this.list.search;
        this.settleNudge?.();
        box.classList.remove("attention");
        void box.offsetWidth;
        box.classList.add("attention");
        const settle = () => {
            box.classList.remove("attention");
            box.removeEventListener("animationend", settle);
            window.clearTimeout(timer);
            this.settleNudge = null;
        };
        const timer = window.setTimeout(settle, NudgeMs);
        box.addEventListener("animationend", settle);
        this.settleNudge = settle;
    }

    unfold(target) {
        if (target === "tape") this.showDeck(true);
        else if (target === FoldableDrive) this.showDrive(true);
    }

    /** Aiming at a drive shows discs, aiming at the deck shows tapes; the chips can widen that. */
    setTarget(target) {
        this.target = target;
        const forTape = target === "tape";
        this.list.kinds = { disc: !forTape, tape: forTape };
        for (const bay of this.bays) bay.section.classList.toggle("target", target === bay.driveIndex);
        this.deck.window.classList.toggle("target", forTape);
        const into = forTape ? "the deck" : `drive ${target}`;
        this.list.openText.textContent = `Open a file into ${into}…`;
        this.list.openLabel.title = forTape
            ? "Open a tape image from this computer; a disc image goes into drive 0"
            : `Open a disc image from this computer into drive ${target}; a tape image goes into the deck`;
        this.list.search.placeholder = forTape
            ? "Search for a tape for the deck"
            : `Search for a disc for drive ${target}`;
        for (const button of this.list.into.querySelectorAll("[data-target]")) {
            const aimed = button.dataset.target === String(target);
            button.classList.toggle("active", aimed);
            button.setAttribute("aria-pressed", String(aimed));
        }
        this.renderChips();
        this.renderList();
    }

    /** What the keys do to the row Enter takes, or where the list is aimed when there is none. */
    renderHint() {
        const first = this.list.rows.querySelector(".media-row-main")?.descriptor;
        const target = first ? this.rowTarget(first) : this.target;
        this.list.hint.replaceChildren(
            ...[...hintKeys(target, this.list.autoboot.checked), ["Esc", "closes"]].map(([key, what]) => {
                const span = document.createElement("span");
                const kbd = document.createElement("kbd");
                kbd.textContent = key;
                span.append(kbd, ` ${what}`);
                return span;
            }),
        );
    }

    /** @returns {Promise<object[]>} the descriptors this refresh fetched, shown unless a newer one overtook it */
    async refreshList() {
        const listing = this.media.listAll();
        this.list.latest = listing;
        const { descriptors, failures } = await listing;
        // A newer refresh has been asked for meanwhile: its answer is the one to show.
        if (this.list.latest !== listing) return descriptors;
        this.list.descriptors = descriptors;
        this.list.failures = failures;
        this.list.loaded = true;
        // A source that has dropped out of the listing cannot stay the one chosen.
        if (this.list.source !== "all" && !descriptors.some((d) => d.source === this.list.source))
            this.list.source = "all";
        this.list.connect.hidden = this.driveSource.connected;
        this.list.newDiscDriveOption.hidden = !this.driveSource.connected;
        this.renderChips();
        this.renderList();
        this.renderAll();
        return descriptors;
    }

    renderChips() {
        const { list } = this;
        const counts = new Map();
        for (const d of list.descriptors) counts.set(d.source, (counts.get(d.source) ?? 0) + 1);
        const chip = (label, title, pressed, onClick) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "media-chip";
            button.textContent = label;
            button.title = title;
            button.setAttribute("aria-pressed", String(pressed));
            button.addEventListener("click", onClick);
            return button;
        };
        const gap = document.createElement("span");
        gap.className = "gap";
        gap.setAttribute("aria-hidden", "true");
        list.chips.replaceChildren(
            chip("All", "Every source", list.source === "all", () => {
                list.source = "all";
                this.renderChips();
                this.renderList();
            }),
            ...Object.entries(Sources)
                .filter(([source]) => counts.has(source))
                .map(([source, { name, title }]) =>
                    chip(`${name} ${counts.get(source)}`, title, list.source === source, () => {
                        list.source = source;
                        this.renderChips();
                        this.renderList();
                    }),
                ),
            gap,
            ...this.kindsOffered.map((kind) =>
                chip(kind === "disc" ? "Discs" : "Tapes", `Show ${kind}s`, list.kinds[kind], () => {
                    list.kinds[kind] = !list.kinds[kind];
                    this.renderChips();
                    this.renderList();
                }),
            ),
        );
    }

    renderList() {
        const { list } = this;
        const shown = list.descriptors
            .filter((d) => this.kindsOffered.includes(d.kind))
            .filter((d) => list.kinds[d.kind] && (list.source === "all" || d.source === list.source))
            .filter((d) => matchesQuery(d, list.query))
            .sort(compareForQuery(list.query));
        const recent = list.query ? [] : this.recentAmong(shown);
        const rest = shown.filter((d) => !recent.includes(d)).slice(0, MaxRows - recent.length);
        const rows = [
            ...(recent.length
                ? [this.buildHeading("Recently loaded"), ...recent.map((d) => this.buildRow(d, { recent: true }))]
                : []),
            ...(recent.length && rest.length ? [this.buildHeading("Everything else")] : []),
            ...rest.map((d) => this.buildRow(d)),
        ];
        const notices = list.failures.map((failure) => {
            const li = document.createElement("li");
            li.className = "notice";
            li.textContent = `Could not list ${failure}`;
            return li;
        });
        if (!list.loaded || shown.length === 0) {
            const li = document.createElement("li");
            li.className = "notice";
            li.textContent = !list.loaded
                ? "Fetching the archives…"
                : list.query
                  ? `Nothing matches "${list.query}"`
                  : "Nothing to show";
            notices.push(li);
        }
        list.rows.replaceChildren(...notices, ...rows);
        this.renderHint();
        list.count.textContent = list.loaded
            ? shown.length > MaxRows
                ? `showing ${MaxRows} of ${shown.length}; keep typing to narrow it`
                : `${shown.length} of ${list.descriptors.length}`
            : "";
    }

    /** The rows that were loaded lately, newest first, each reference once. */
    recentAmong(shown) {
        const { recent } = this.slots;
        const ranked = new Map();
        for (const d of shown) {
            const rank = recent.rank(d);
            if (rank >= 0 && !ranked.has(rank)) ranked.set(rank, d);
        }
        return [...ranked].sort(([a], [b]) => a - b).map(([, d]) => d);
    }

    /** A heading for the eye only: each recent row's label says it was loaded recently. */
    buildHeading(words) {
        const li = document.createElement("li");
        li.className = "media-heading small text-uppercase text-muted px-2 pt-2 pb-1";
        li.setAttribute("aria-hidden", "true");
        li.textContent = words;
        return li;
    }

    buildRow(d, { recent = false } = {}) {
        const li = document.createElement("li");
        li.className = "media-row";
        const main = document.createElement("button");
        main.type = "button";
        main.className = "media-row-main";
        const target = this.rowTarget(d);
        const label = [d.title, d.publisher, d.detail, sourceName(d.source)].filter(Boolean).join(", ");
        main.title = this.actionWords(target, label);
        main.setAttribute("aria-label", recent ? `${main.title}, recently loaded` : main.title);
        const cell = (className, text) => {
            const span = document.createElement("span");
            span.className = className;
            span.textContent = text;
            return span;
        };
        const detail = cell("detail", d.detail);
        if (d.savesChanges) {
            const saves = cell("saves", "saves changes");
            saves.title = "Writes to this disc are kept";
            detail.prepend(saves, d.detail ? " · " : "");
        }
        const inDrive = this.slotHolding(d);
        if (inDrive !== null) detail.append(detail.textContent ? " · " : "", cell("in-drive", `in ${inDrive}`));
        const source = cell(`media-source src-${d.source}`, sourceName(d.source));
        source.title = Sources[d.source]?.title ?? "";
        const keycap = cell("media-keycap", target === "tape" ? "T" : String(target));
        keycap.setAttribute("aria-hidden", "true");
        main.append(
            cell(`title${d.publisher || d.detail ? "" : " thin"}`, d.title),
            cell("publisher", d.publisher),
            detail,
            source,
            keycap,
        );
        main.descriptor = d;
        main.entry = recent ? "recent" : "list";
        main.addEventListener("click", (e) => this.loadInto(target, d, { shift: e.shiftKey, entry: main.entry }));
        const targets = document.createElement("span");
        targets.className = "targets";
        if (d.kind === "disc") {
            const other = otherDrive(target === "tape" ? 0 : target);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "media-target";
            button.textContent = String(other);
            button.title = this.actionWords(other, d.title);
            button.setAttribute("aria-label", button.title);
            button.addEventListener("click", (e) => this.loadDisc(other, d, { shift: e.shiftKey, entry: main.entry }));
            targets.append(button);
        }
        const page = webPage(d.url);
        if (page) {
            const about = document.createElement("a");
            about.className = "media-target media-about";
            about.href = page.href;
            about.target = "_blank";
            about.rel = "noopener";
            about.textContent = "↗";
            about.title = `About ${d.title} at ${page.host}`;
            about.setAttribute("aria-label", about.title);
            targets.append(about);
        }
        li.append(main, targets);
        return li;
    }

    /** What a plain click on something named `label` does when it goes to `target`. */
    actionWords(target, label) {
        if (target === "tape") return `Load ${label} into the cassette deck`;
        return this.decideBoot(target).boots
            ? `Boot ${label} from drive ${target}`
            : `Load ${label} into drive ${target}`;
    }

    /** What a load into `driveIndex` does, by the Autoboot tick as it is now. */
    decideBoot(driveIndex, asked = {}) {
        return bootDecision({ driveIndex, ticked: this.list.autoboot.checked, ...asked });
    }

    /** Which slot a descriptor's media is loaded in, as text, or null. */
    slotHolding(d) {
        return this.slots.holding(d.ref)?.name ?? null;
    }

    /** The drive the list is aimed at; aiming at the deck leaves discs going to drive 0. */
    get targetDrive() {
        return this.target === "tape" ? 0 : this.target;
    }

    /** Where a row's own action sends its descriptor: the deck for a tape, the aimed drive for a disc. */
    rowTarget(d) {
        return d.kind === "tape" ? "tape" : this.targetDrive;
    }

    loadInto(target, d, options = {}) {
        if (d.kind === "tape") return this.loadTape(d, options);
        return this.loadDisc(target, d, options);
    }

    /**
     * Google Drive has just been connected: the list can show it, and a drive whose disc from
     * there could not be loaded before (the URL named it at startup, say) can be filled.
     */
    async loadDriveDiscs() {
        const descriptors = await this.refreshList();
        for (const slot of this.slots.driveSlots) {
            const wanted = slot.failed?.descriptor;
            if (slot.media || slot.busy || wanted?.source !== "gdrive") continue;
            const listed = descriptors.find((d) => d.ref === wanted.ref) ?? wanted;
            await this.loadDisc(slot.index, listed, { ...this.askedOf(slot.index), stayOpen: true, entry: "retry" });
        }
    }

    /**
     * @param {object} [options] `shift`: the gesture had Shift held, so it does the opposite of the
     *   Autoboot tick; `boot`: boot or not whatever the tick says; `stayOpen`: the load was not what the
     *   window was opened for; `entry`: how it was asked for
     */
    async loadDisc(driveIndex, d, { shift = false, boot, stayOpen = false, entry } = {}) {
        this.unfold(driveIndex);
        const slot = this.slots.drive(driveIndex);
        if (
            !this.machineSwitch.satisfies(d) &&
            (await this.machineSwitch.switchFor(d, slot, { boot: this.decideBoot(driveIndex, { shift, boot }).boots }))
        ) {
            this.slots.recent.note(d.ref, "disc");
            return;
        }
        const asked = (this.asked[driveIndex] = { shift, boot });
        const outcome = await this.slots.load(slot, d, { entry });
        if (outcome !== "failed" && this.asked[driveIndex] === asked) this.asked[driveIndex] = null;
        if (outcome !== "loaded") return;
        // The tick is read now, not before the wait, in case it was changed meanwhile.
        this.loaded(driveIndex, asked);
        if (!stayOpen) this.close();
    }

    /**
     * A retry asks for what the failed load asked for; a load the window did not ask for, as a link's
     * was, boots as the URL says.
     */
    askedOf(driveIndex) {
        return this.asked[driveIndex] ?? { boot: this.media.params.autoboot !== undefined };
    }

    /** Boots what has just gone into a drive if it is to, and has the URL say whether a link to it boots. */
    loaded(driveIndex, asked) {
        const { inUrl } = this.slots.drive(driveIndex);
        const { boots, urlAutoboot } = this.decideBoot(driveIndex, { ...asked, inUrl });
        if (boots) {
            this.processor.reset(true);
            this.boot();
        }
        if (urlAutoboot !== undefined) this.media.setAutoboot(urlAutoboot);
    }

    async loadTape(d, { entry } = {}) {
        this.unfold("tape");
        if ((await this.slots.load(this.slots.deck, d, { entry })) === "loaded") this.close();
    }

    boot() {
        noteFeature(this.panel, "boot");
        this.autoboot();
    }

    /**
     * The name form, for a blank disc or for a copy of what a drive holds; the
     * copy can only go to Google Drive, since a browser-local disc saves in place.
     */
    showDiscForm({ copyFrom }) {
        const { list } = this;
        list.copyFrom = copyFrom;
        const copying = copyFrom !== null;
        const disc = copying ? this.slots.drive(copyFrom).media : null;
        list.newDiscLabel.textContent = copying ? `Copy the disc in drive ${copyFrom} to Google Drive as` : "Name";
        list.newDiscWhere.hidden = copying;
        list.newDiscForm.querySelector(`input[value="${copying ? "gdrive" : "browser"}"]`).checked = true;
        list.newDiscName.value = disc ? disc.name.split("/").pop() : "";
        list.newDiscForm.hidden = false;
        list.newDiscName.focus();
        list.newDiscName.select();
    }

    /** Save to Google Drive on a bay: connect if need be, then ask for the copy's name. */
    async offerCopyToDrive(driveIndex) {
        if (!this.driveSource.connected && !(await this.driveSource.connect())) return;
        this.loadDriveDiscs();
        this.showList(true);
        this.showDiscForm({ copyFrom: driveIndex });
    }

    /**
     * A disc kept in this browser or on Google Drive, put in the aimed drive:
     * blank and formatted, or a copy of what a drive holds. A name with no
     * extension is an SSD; an HFE can only be a blank on Google Drive.
     */
    async createDisc(name, where) {
        if (!name) return;
        const copyFrom = this.list.copyFrom;
        const discType = guessDiscTypeFromName(name);
        const blankFluxOnDrive = discType.isFluxImage && copyFrom === null && where === "gdrive";
        if (!discType.supportsCatalogue && !blankFluxOnDrive) name = replaceOrAddExtension(name, ".ssd");
        const driveIndex = copyFrom ?? this.targetDrive;
        this.list.newDiscForm.hidden = true;
        if (copyFrom === null && where === "browser")
            return this.loadDisc(driveIndex, describeBrowserDisc(name), { boot: false, entry: "create" });
        const copied = copyFrom === null ? null : await this.drives.sectorImage(copyFrom);
        if (copyFrom !== null && !copied) return;
        const layout = this.drives.layoutForDrive(driveIndex);
        const making = { ref: undefined, kind: "disc", title: name, publisher: "", detail: "", source: "gdrive" };
        const outcome = await this.slots.load(this.slots.drive(driveIndex), making, {
            entry: "create",
            fetch: async () => {
                const { ref, disc } =
                    copyFrom === null
                        ? await this.driveSource.createBlank(name, layout)
                        : await this.driveSource.createFrom(name, copied, layout);
                return { media: disc, ref };
            },
        });
        if (outcome !== "loaded") return;
        this.loaded(driveIndex, { boot: false });
        this.close();
    }

    /** Folds the recorder to one line, or unfolds it. */
    showDeck(shown) {
        this.panel.classList.toggle("deck-collapsed", !shown);
        this.deck.bar.setAttribute("aria-expanded", String(shown));
    }

    /** Folds the second drive to one line, or unfolds it. */
    showDrive(shown) {
        const bay = this.bays[FoldableDrive];
        bay.section.classList.toggle("folded", !shown);
        bay.bar.setAttribute("aria-expanded", String(shown));
    }

    /** Folds the list to one line, or unfolds it. */
    showList(shown) {
        this.panel.classList.toggle("list-collapsed", !shown);
        this.list.bar.setAttribute("aria-expanded", String(shown));
    }

    renderAll() {
        for (const bay of this.bays) this.renderDrive(bay.driveIndex);
        this.renderDeck();
    }

    /** The DFS title and cycle number off the disc, kept up to date as its catalogue is written. */
    showSticker(bay) {
        const disc = this.slots.drive(bay.driveIndex).media;
        if (bay.watched !== disc) {
            bay.watched?.removeTrackWriteListener(bay.onTrackWrite);
            disc?.addTrackWriteListener(bay.onTrackWrite);
            bay.watched = disc ?? null;
        }
        const catalogue = disc ? dfsCatalogue(disc) : null;
        bay.dfs.textContent = catalogue?.title ? `${catalogue.title} (${catalogue.cycle})` : "";
        bay.dfs.hidden = !catalogue?.title;
    }

    /** The title the list gave a reference, when it has one, else what the machine calls it. */
    nameFor(ref, fallback) {
        return (ref && this.list.descriptors.find((d) => d.ref === ref)?.title) || fallback;
    }

    renderDrive(driveIndex) {
        const bay = this.bays[driveIndex];
        const { media: disc, busy, failed, ref } = this.slots.drive(driveIndex);
        const drive = this.processor.fdc?.drives[driveIndex];
        const readout = this.readouts[driveIndex];
        bay.section.dataset.state = busy ? "busy" : disc ? "loaded" : "empty";
        for (const radio of bay.radios) {
            radio.checked = !!drive && radio.value === tracksLabel(drive.tracksPerStep);
            radio.disabled = !drive;
        }
        for (const control of [bay.save, bay.surface, bay.report]) control.disabled = !disc || !!busy;
        this.showNotes(bay, busy ? [] : (disc?.loadNotes ?? []));
        bay.eject.disabled = !!busy;
        bay.fail.textContent = failed ? `could not load ${failed.descriptor.title}: ${errorText(failed.error)}` : "";
        bay.retry.hidden = !failed;
        bay.hide.hidden = driveIndex !== FoldableDrive || !!disc || !!busy;
        if (busy) {
            bay.status.textContent = `loading ${busy.title} from ${sourceName(busy.source)}…`;
            bay.kept.textContent = "";
        } else if (!disc) {
            bay.eject.title = `Drive ${driveIndex} is empty; click to pick a disc for it from the list`;
            bay.slot.title = `Drive ${driveIndex} is empty; click to pick a disc for it from the list`;
            bay.status.textContent = drive
                ? `nothing loaded · reads ${tracksLabel(drive.tracksPerStep)} track discs`
                : "no drive";
            bay.title.textContent = "";
            bay.sub.textContent = "";
            bay.kept.textContent = "";
            this.showSticker(bay);
            bay.barName.textContent = "empty";
            readout.querySelector(".name").textContent = "empty";
            readout.title = `Drive ${driveIndex} is empty. Click to open the media window`;
        } else {
            const tracks = tracksLabel(drive.tracksPerStep);
            const sides = disc.isDoubleSided
                ? `2 sides (drives ${driveIndex} and ${upperSideOf(driveIndex)})`
                : "1 side";
            const source = sourceOf(ref);
            const name = this.nameFor(ref, disc.name);
            bay.title.textContent = name;
            this.showSticker(bay);
            bay.sub.textContent = [`${tracks} track`, sides, source].filter(Boolean).join(" · ");
            bay.status.textContent = [`${tracks}T`, sides, source].filter(Boolean).join(" · ");
            bay.kept.textContent = disc.savesChanges ? "· keeps changes" : "· changes are not being kept";
            bay.kept.classList.toggle("warn", !disc.savesChanges);
            bay.kept.title = disc.savesChanges
                ? "Writes to this disc are saved where it came from"
                : "Writes to this disc are lost when the page reloads; use Save to keep a copy";
            bay.eject.title = `Eject ${name} from drive ${driveIndex}`;
            bay.slot.title = `${name} is in drive ${driveIndex}; click to pick something else for it`;
            bay.barName.textContent = name;
            readout.querySelector(".name").textContent = shortName(name);
            readout.title = `Drive ${driveIndex} holds ${name}, ${tracks} track. Click to open the media window`;
        }
        this.showSummary();
    }

    /** What loading the disc found out, oddities picked out. */
    showNotes(bay, notes) {
        bay.notes.replaceChildren(
            ...notes.flatMap(({ text, isOdd }, index) => {
                const part = document.createElement("span");
                part.textContent = text;
                part.classList.toggle("warn", isOdd);
                return index ? [" · ", part] : [part];
            }),
        );
        bay.notes.title = notes.map(({ text }) => text).join("\n");
        bay.notes.hidden = !notes.length;
    }

    renderDeck() {
        const { deck } = this;
        const { media: tape, busy, failed, ref } = this.slots.deck;
        const { playPressed, tapeRunning } = this.processor.tapeInterface;
        const isAtom = this.model.isAtom;
        const readout = this.readouts.tape;
        deck.section.classList.toggle("busy", !!busy);
        deck.cassette.hidden = !tape;
        deck.empty.hidden = !!tape;
        deck.rewind.disabled = !tape;
        deck.eject.disabled = !tape || !!busy;
        deck.play.disabled = !tape || playPressed;
        deck.stop.disabled = !tape || !playPressed;
        deck.play.setAttribute("aria-pressed", String(playPressed));
        deck.play.title = isAtom ? "Play the tape" : "Play: the tape runs whenever the BBC switches its motor on";
        deck.stop.title = isAtom ? "Stop the tape" : "Stop: the tape stays put however the BBC sets its motor";
        deck.fail.textContent = failed ? `could not load ${failed.descriptor.title}: ${errorText(failed.error)}` : "";
        deck.retry.hidden = !failed;
        deck.hide.hidden = !!tape || !!busy;
        if (busy) {
            deck.status.textContent = `loading ${busy.title} from ${sourceName(busy.source)}…`;
        } else if (!tape) {
            deck.window.title = "The deck is empty; click to pick a tape for it from the list";
            deck.eject.title = "Nothing to eject";
            deck.status.textContent = "nothing loaded";
            deck.barName.textContent = "empty";
            readout.querySelector(".name").textContent = "empty";
            readout.title = "The cassette deck is empty. Click to open the media window";
        } else {
            const source = sourceOf(ref);
            const name = this.nameFor(ref, tape.name);
            deck.title.textContent = name;
            deck.sub.textContent = source ?? "";
            deck.window.title = `${name} is in the deck; click to pick another tape for it`;
            deck.eject.title = `Eject ${name}`;
            const { motorOn } = this.processor.tapeInterface;
            const state = tapeRunning
                ? "playing"
                : !playPressed || isAtom
                  ? "stopped"
                  : motorOn
                    ? "at the end"
                    : "motor off";
            deck.status.textContent = [name, source, state].filter(Boolean).join(" · ");
            deck.barName.textContent = name;
            readout.querySelector(".name").textContent = shortName(name);
            readout.title = `The cassette deck holds ${name}. Click to open the media window`;
        }
        this.showCounter();
        this.showSummary();
    }

    showSummary() {
        const drives = this.processor.fdc?.drives ?? [];
        const parts = drives.map((drive, i) => `${i}: ${drive.disc?.name ?? "empty"}`);
        parts.push(`tape: ${this.processor.tapeInterface.tape?.name ?? "empty"}`);
        this.summary.textContent = parts.join(" · ");
    }

    tapeCount() {
        const tape = this.processor.tapeInterface.tape;
        return tape ? Math.floor(tape.position * (CounterDivisions - 1)) : 0;
    }

    showCounter() {
        const reading = (this.tapeCount() - this.counterBase + CounterDivisions) % CounterDivisions;
        const digits = this.processor.tapeInterface.tape ? counterDigits(reading) : "";
        if (digits === this.lastCounter) return;
        this.lastCounter = digits;
        const shown = digits || counterDigits(0);
        this.deck.counter.querySelectorAll("b").forEach((digit, i) => (digit.textContent = shown[i]));
        this.deck.counter.setAttribute("aria-label", `Tape counter ${shown}`);
        this.readouts.tape.querySelector(".counter").textContent = digits;
    }

    /** Cheap enough to run every emulation tick: the lights, the reels and the counter. */
    tick() {
        const { tapeInterface, fdc } = this.processor;
        const running = !!(tapeInterface.tape && tapeInterface.tapeRunning);
        if (running !== this.deck.section.classList.contains("motor")) {
            this.deck.section.classList.toggle("motor", running);
            this.deck.data.classList.toggle("on", running);
            this.readouts.tape.classList.toggle("motor", running);
            this.renderDeck();
        }
        this.showCounter();
        if (!this.isOpen) return;
        for (const bay of this.bays) {
            const lit = !!fdc?.motorOn[bay.driveIndex];
            if (lit !== bay.led.classList.contains("on")) {
                bay.led.classList.toggle("on", lit);
                const title = lit
                    ? `Drive ${bay.driveIndex} selected by the disc controller`
                    : `Drive ${bay.driveIndex} idle`;
                bay.led.title = title;
                bay.led.setAttribute("aria-label", title);
            }
        }
    }
}
