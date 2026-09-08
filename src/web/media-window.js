import { dfsCatalogue } from "../disc.js";
import { splitImage } from "../media-resolver.js";
import { replaceOrAddExtension } from "../archive.js";
import { FloatingPanel } from "./floating-panel.js";
import { tracksLabel, tracksPerStepOf } from "./drives.js";
import { Sources, compareForQuery, describeBrowserDisc, matchesQuery } from "./media-catalogue.js";
import { errorText, reportLoadFailure } from "./reporting.js";
import { guessDiscTypeFromName } from "../fdc.js";
import { toast } from "./toast.js";
import { noteEvent } from "./analytics.js";

// The source behind each URL schema the list knows, and words for the schemas it does not.
const SchemaSources = {
    "": "builtin",
    sth: "sth",
    "|": "sth",
    hfe: "hfe",
    gd: "gdrive",
    local: "browser",
    "!": "browser",
};
const OtherSchemaPhrases = { http: "the web", https: "the web", file: "a file", data: "the URL", b64data: "the URL" };

const CounterDigits = 3;
const CounterDivisions = 10 ** CounterDigits;

// Beyond this the list is a scroll nobody reads; the search box narrows it.
const MaxRows = 100;

// How long the search box stays highlighted where motion is off, and a backstop where it is on.
const NudgeMs = 2000;
// The drive almost nobody uses, folded to one line until it holds something or is aimed at.
const FoldableDrive = 1;

/** Where a URL reference came from, in words, or null when the URL names nothing. */
export function sourceOf(ref) {
    if (!ref) return null;
    const { schema } = splitImage(ref);
    return Sources[SchemaSources[schema]]?.phrase ?? OtherSchemaPhrases[schema] ?? null;
}

const sourceName = (source) => Sources[source]?.name ?? source;
const targetFrom = (slot) => (slot === "tape" ? "tape" : Number(slot));

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
export class MediaWindow {
    constructor({ media, drives, processor, model, loop, visualiser, autoboot, driveSource }) {
        this.media = media;
        this.drives = drives;
        this.processor = processor;
        this.model = model;
        this.visualiser = visualiser;
        this.autoboot = autoboot;
        this.driveSource = driveSource;

        this.panel = document.getElementById("media-panel");
        this.floating = new FloatingPanel({
            panel: this.panel,
            header: this.panel.querySelector(".media-header"),
            closeButton: document.getElementById("media-close"),
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

        for (const opener of document.querySelectorAll(".media-window-open"))
            opener.addEventListener("click", (e) => {
                e.preventDefault();
                const { slot } = opener.dataset;
                if (slot === undefined) this.open();
                else this.openFor(targetFrom(slot));
            });
        this.floating.addEventListener("open", () => this.refreshList());
        this.floating.addEventListener("close", () => (this.list.newDiscForm.hidden = true));
        // Whatever arrives in a slot, by whichever route, is what it holds: a load of the window's
        // own still in flight has been overtaken, and a failure it was showing is settled.
        drives.addEventListener("disc-changed", (e) => {
            const { driveIndex, disc } = e.detail;
            const bay = this.bays[driveIndex];
            bay.busy = null;
            bay.failed = null;
            if (disc && driveIndex === FoldableDrive) this.showDrive(true);
            this.renderDrive(driveIndex);
            // The rows say which slot holds them.
            this.renderList();
        });
        drives.addEventListener("tracks-changed", (e) => this.renderDrive(e.detail.driveIndex));
        media.addEventListener("tape-changed", (e) => {
            this.deck.busy = null;
            this.deck.failed = null;
            this.counterBase = 0;
            if (e.detail.tape) this.showDeck(true);
            this.renderDeck();
            this.renderList();
        });
        media.addEventListener("restored", () => this.renderAll());
        // A file opened while the window is up joins the list; closed, the next open lists it anyway.
        media.addEventListener("files-changed", () => {
            if (this.isOpen) this.refreshList();
        });
        // The URL is named after the bytes arrive, so the source line catches up here.
        media.addEventListener("media-changed", () => this.renderAll());
        loop.addEventListener("tick", () => this.tick());
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

    get isOpen() {
        return this.floating.isOpen;
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
            radios: [...pitch.querySelectorAll("input")],
            busy: null,
            failed: null,
            watched: null,
            onTrackWrite: (isSideUpper, trackNum) => {
                if (!isSideUpper && trackNum === 0) this.showSticker(bay);
            },
        };
        // The latch ejects a disc, and on an empty drive it is where you would put one in.
        bay.eject.addEventListener("click", () => {
            if (this.processor.fdc?.drives[driveIndex]?.disc) this.media.ejectDisc(driveIndex);
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
        bay.retry.addEventListener("click", () => this.loadDisc(driveIndex, bay.failed.descriptor));
        section
            .querySelector(".bay-save-ssd")
            .addEventListener("click", () => this.drives.downloadSsdOrDsd(driveIndex));
        section.querySelector(".bay-save-hfe").addEventListener("click", () => this.drives.downloadHfe(driveIndex));
        section.querySelector(".bay-save-drive").addEventListener("click", () => this.offerCopyToDrive(driveIndex));
        bay.save.title = `Download drive ${driveIndex}'s disc as an image`;
        bay.surface.title = `Open the disc surface window on drive ${driveIndex}`;
        bay.surface.addEventListener("click", () => this.visualiser.openOn(driveIndex));
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
            busy: null,
            failed: null,
        };
        deck.window.addEventListener("click", () => this.aimAt("tape"));
        deck.eject.addEventListener("click", () => this.media.ejectTape());
        deck.retry.addEventListener("click", () => this.loadTape(deck.failed.descriptor));
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
            source: "all",
            kinds: { disc: true, tape: true },
            loaded: false,
        };
        list.search.addEventListener("input", () => {
            list.query = list.search.value.trim();
            this.renderList();
        });
        // Enter takes the first match; the arrows walk the rows and come back to the box.
        list.search.addEventListener("keydown", (e) => {
            const first = list.rows.querySelector(".media-row-main");
            if (e.key === "Enter" && first) {
                e.preventDefault();
                this.loadInto(this.rowTarget(first.descriptor), first.descriptor, { boot: e.shiftKey });
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
            noteEvent("local", "clickWindow");
            try {
                const outcome = await this.media.openFile(file, this.targetDrive);
                if (outcome) {
                    toast(outcome, { title: "Opened" });
                    this.close();
                }
            } catch (error) {
                reportLoadFailure(file.name, error);
            }
            evt.target.value = "";
        });
        list.connect.addEventListener("click", async () => {
            if (await this.driveSource.connect()) this.loadDriveDiscs();
        });
        list.autoboot.addEventListener("change", () => this.media.setAutoboot(list.autoboot.checked));
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
        this.list.hint.replaceChildren(
            ...[
                ["Enter", `loads into ${into}`],
                ...(target === 0 ? [["Shift+Enter", "loads, ticks Autoboot and boots"]] : []),
                ["Esc", "closes"],
            ].map(([key, what]) => {
                const span = document.createElement("span");
                const kbd = document.createElement("kbd");
                kbd.textContent = key;
                span.append(kbd, ` ${what}`);
                return span;
            }),
        );
        this.renderChips();
        this.renderList();
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
        this.list.autoboot.checked = this.media.params.autoboot !== undefined;
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
            ...["disc", "tape"].map((kind) =>
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
            .filter((d) => list.kinds[d.kind] && (list.source === "all" || d.source === list.source))
            .filter((d) => matchesQuery(d, list.query))
            .sort(compareForQuery(list.query));
        const rows = shown.slice(0, MaxRows).map((d) => this.buildRow(d));
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
        list.count.textContent = list.loaded
            ? shown.length > MaxRows
                ? `showing ${MaxRows} of ${shown.length}; keep typing to narrow it`
                : `${shown.length} of ${list.descriptors.length}`
            : "";
    }

    buildRow(d) {
        const li = document.createElement("li");
        li.className = "media-row";
        const main = document.createElement("button");
        main.type = "button";
        main.className = "media-row-main";
        const target = this.rowTarget(d);
        const targetName = target === "tape" ? "the cassette deck" : `drive ${target}`;
        const label = [d.title, d.publisher, d.detail, sourceName(d.source)].filter(Boolean).join(", ");
        main.title = `Load ${label} into ${targetName}`;
        main.setAttribute("aria-label", main.title);
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
        main.addEventListener("click", (e) => this.loadInto(target, d, { boot: e.shiftKey }));
        const targets = document.createElement("span");
        targets.className = "targets";
        if (d.kind === "disc") {
            const other = otherDrive(target === "tape" ? 0 : target);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "media-target";
            button.textContent = String(other);
            button.title = `Load ${d.title} into drive ${other}`;
            button.setAttribute("aria-label", button.title);
            button.addEventListener("click", (e) => this.loadDisc(other, d, { boot: e.shiftKey }));
            targets.append(button);
        }
        li.append(main, targets);
        return li;
    }

    /** Which slot a descriptor's media is loaded in, as text, or null. */
    slotHolding(d) {
        // A file opened this session is unnamed in the URL; the slot knows it by its name.
        const isIn = (ref, name) => (d.source === "session" ? name === d.title : ref === d.ref);
        for (const driveIndex of [0, 1]) {
            const disc = this.processor.fdc?.drives[driveIndex].disc;
            if (disc && isIn(this.media.refInDrive(driveIndex), disc.name)) return `drive ${driveIndex}`;
        }
        const { tape } = this.processor.tapeInterface;
        if (tape && isIn(this.media.params.tape, tape.name)) return "the deck";
        return null;
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
        if (d.kind === "tape") return this.loadTape(d);
        return this.loadDisc(target, d, options);
    }

    /** A reference the URL can carry, or nothing for a file opened this session. */
    static urlRef(d) {
        return d.source === "session" ? undefined : d.ref;
    }

    /**
     * Google Drive has just been connected: the list can show it, and a drive the URL says
     * holds one of its discs, which could not be loaded before, can be filled.
     */
    async loadDriveDiscs() {
        const descriptors = await this.refreshList();
        for (const driveIndex of [0, 1]) {
            if (this.processor.fdc?.drives[driveIndex]?.disc || this.bays[driveIndex].busy) continue;
            const named = descriptors.find((d) => d.ref === this.media.refInDrive(driveIndex));
            if (named?.source === "gdrive") await this.loadDisc(driveIndex, named, { stayOpen: true });
        }
    }

    /**
     * @param {object} [options] `boot`: tick Autoboot, so the URL says what happened, and boot the
     *   disc; `stayOpen`: the load was not what the window was opened for
     */
    async loadDisc(driveIndex, d, { boot = false, stayOpen = false } = {}) {
        noteEvent("media", "loadDisc", d.ref);
        const bay = this.bays[driveIndex];
        const claim = this.drives.claim(driveIndex);
        bay.busy = d;
        bay.failed = null;
        this.unfold(driveIndex);
        this.renderDrive(driveIndex);
        // Only drive 0 boots, so only a boot into drive 0 means anything for the URL.
        boot = boot && driveIndex === 0;
        try {
            const loaded = await this.media.loadDiscImage(d.ref, this.drives.layoutForDrive(driveIndex));
            if (!this.drives.holds(driveIndex, claim)) return this.overtaken(bay, d);
            bay.busy = null;
            // The tick is read now, not before the wait, in case it was changed meanwhile.
            const needsAutoboot = boot || (driveIndex === 0 && this.media.params.autoboot !== undefined);
            // The machine is only reset once there is a disc to boot.
            if (needsAutoboot) this.processor.reset(true);
            this.drives.putDiscIn(driveIndex, loaded, claim);
            this.media.setDiscImage(driveIndex, MediaWindow.urlRef(d));
            if (boot) {
                this.media.setAutoboot(true);
                this.showAutoboot(true);
            }
            if (needsAutoboot) this.autoboot(d.title);
            if (!stayOpen) this.close();
        } catch (error) {
            if (!this.drives.holds(driveIndex, claim)) return this.overtaken(bay, d);
            bay.busy = null;
            bay.failed = { descriptor: d, error };
            reportLoadFailure(`${d.title} from ${sourceName(d.source)}`, error);
        }
        this.renderDrive(driveIndex);
        this.renderList();
    }

    async loadTape(d) {
        noteEvent("media", "loadTape", d.ref);
        const { deck } = this;
        const claim = this.media.claimTape();
        deck.busy = d;
        deck.failed = null;
        this.unfold("tape");
        this.renderDeck();
        try {
            const tape = await this.media.loadTapeImage(d.ref);
            if (!this.media.holdsTape(claim)) return this.overtaken(deck, d);
            deck.busy = null;
            this.media.setProcessorTape(tape, claim);
            this.media.setTapeImage(MediaWindow.urlRef(d));
            this.close();
        } catch (error) {
            if (!this.media.holdsTape(claim)) return this.overtaken(deck, d);
            deck.busy = null;
            deck.failed = { descriptor: d, error };
            reportLoadFailure(`${d.title} from ${sourceName(d.source)}`, error);
        }
        this.renderDeck();
        this.renderList();
    }

    /**
     * A load of the window's own finished after something else claimed its slot. If that something
     * put media in, the slot has already redrawn; if it failed, the slot would otherwise stay "loading".
     */
    overtaken(slot, descriptor) {
        if (slot.busy !== descriptor) return;
        slot.busy = null;
        this.renderAll();
    }

    /** Ticks or clears the autoboot box, for whoever changed the setting elsewhere. */
    showAutoboot(checked) {
        this.list.autoboot.checked = checked;
    }

    /**
     * The name form, for a blank disc or for a copy of what a drive holds; the
     * copy can only go to Google Drive, since a browser-local disc saves in place.
     */
    showDiscForm({ copyFrom }) {
        const { list } = this;
        list.copyFrom = copyFrom;
        const copying = copyFrom !== null;
        const disc = copying ? this.processor.fdc?.drives[copyFrom]?.disc : null;
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
     * extension is an SSD.
     */
    async createDisc(name, where) {
        if (!name) return;
        if (!guessDiscTypeFromName(name).supportsCatalogue) name = replaceOrAddExtension(name, ".ssd");
        const copyFrom = this.list.copyFrom;
        const driveIndex = copyFrom ?? this.targetDrive;
        this.list.newDiscForm.hidden = true;
        if (copyFrom === null && where === "browser") return this.loadDisc(driveIndex, describeBrowserDisc(name));
        const copied = copyFrom === null ? null : await this.drives.sectorImage(copyFrom);
        if (copyFrom !== null && !copied) return;
        const bay = this.bays[driveIndex];
        const claim = this.drives.claim(driveIndex);
        bay.busy = { title: name, source: "gdrive" };
        bay.failed = null;
        this.renderDrive(driveIndex);
        try {
            const layout = this.drives.layoutForDrive(driveIndex);
            const { ref, disc } =
                copyFrom === null
                    ? await this.driveSource.createBlank(name, layout)
                    : await this.driveSource.createFrom(name, copied, layout);
            if (!this.drives.holds(driveIndex, claim)) return this.overtaken(bay, bay.busy);
            bay.busy = null;
            this.drives.putDiscIn(driveIndex, disc, claim);
            this.media.setDiscImage(driveIndex, ref);
            this.close();
        } catch (error) {
            if (!this.drives.holds(driveIndex, claim)) return this.overtaken(bay, bay.busy);
            bay.busy = null;
            console.error(`Could not save ${name} to Google Drive:`, error);
            toast(`Could not save ${name} to Google Drive: ${errorText(error)}`, { title: "Google Drive" });
        }
        this.renderDrive(driveIndex);
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
        const disc = this.processor.fdc?.drives[bay.driveIndex]?.disc;
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
        const drive = this.processor.fdc?.drives[driveIndex];
        const disc = drive?.disc;
        const readout = this.readouts[driveIndex];
        bay.section.dataset.state = bay.busy ? "busy" : disc ? "loaded" : "empty";
        for (const radio of bay.radios) {
            radio.checked = !!drive && radio.value === tracksLabel(drive.tracksPerStep);
            radio.disabled = !drive;
        }
        for (const control of [bay.save, bay.surface]) control.disabled = !disc || !!bay.busy;
        bay.eject.disabled = !!bay.busy;
        bay.fail.textContent = bay.failed
            ? `could not load ${bay.failed.descriptor.title}: ${errorText(bay.failed.error)}`
            : "";
        bay.retry.hidden = !bay.failed;
        bay.hide.hidden = driveIndex !== FoldableDrive || !!disc || !!bay.busy;
        if (bay.busy) {
            bay.status.textContent = `loading ${bay.busy.title} from ${sourceName(bay.busy.source)}…`;
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
            const ref = this.media.refInDrive(driveIndex);
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

    renderDeck() {
        const { deck } = this;
        const { tape, playPressed, tapeRunning } = this.processor.tapeInterface;
        const isAtom = this.model.isAtom;
        const readout = this.readouts.tape;
        deck.section.classList.toggle("busy", !!deck.busy);
        deck.cassette.hidden = !tape;
        deck.empty.hidden = !!tape;
        deck.rewind.disabled = !tape;
        deck.eject.disabled = !tape || !!deck.busy;
        deck.play.disabled = !tape || playPressed;
        deck.stop.disabled = !tape || !playPressed;
        deck.play.setAttribute("aria-pressed", String(playPressed));
        deck.play.title = isAtom ? "Play the tape" : "Play: the tape runs whenever the BBC switches its motor on";
        deck.stop.title = isAtom ? "Stop the tape" : "Stop: the tape stays put however the BBC sets its motor";
        deck.fail.textContent = deck.failed
            ? `could not load ${deck.failed.descriptor.title}: ${errorText(deck.failed.error)}`
            : "";
        deck.retry.hidden = !deck.failed;
        deck.hide.hidden = !!tape || !!deck.busy;
        if (deck.busy) {
            deck.status.textContent = `loading ${deck.busy.title} from ${sourceName(deck.busy.source)}…`;
        } else if (!tape) {
            deck.window.title = "The deck is empty; click to pick a tape for it from the list";
            deck.eject.title = "Nothing to eject";
            deck.status.textContent = "nothing loaded";
            deck.barName.textContent = "empty";
            readout.querySelector(".name").textContent = "empty";
            readout.title = "The cassette deck is empty. Click to open the media window";
        } else {
            const source = sourceOf(this.media.params.tape);
            const name = this.nameFor(this.media.params.tape, tape.name);
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
