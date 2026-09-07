import { dfsCatalogue } from "../disc.js";
import { splitImage } from "../media-resolver.js";
import { FloatingPanel } from "./floating-panel.js";
import { Sources, scoreQuery } from "./media-catalogue.js";
import { errorText, reportLoadFailure } from "./reporting.js";
import { toast } from "./toast.js";
import { noteEvent } from "./analytics.js";

const SourceNames = {
    "": "built in",
    sth: "STH archive",
    "|": "STH archive",
    hfe: "HFE archive",
    gd: "Google Drive",
    local: "this browser",
    "!": "this browser",
    http: "the web",
    https: "the web",
    file: "a file",
    data: "the URL",
    b64data: "the URL",
    session: "a file opened this session",
};

// The counter has three digits, and a tape run end to end turns it over once.
const CounterDivisions = 1000;

// Beyond this the list is a scroll nobody reads; the search box narrows it.
const MaxRows = 100;

const DriveKeys = ["disc1", "disc2"];
// The drive almost nobody uses, folded to one line until it holds something or is aimed at.
const FoldableDrive = 1;

/** Where a URL reference came from, in words, or null when the URL names nothing. */
export function sourceOf(ref) {
    if (!ref) return null;
    return SourceNames[splitImage(ref).schema] ?? null;
}

const tracksOf = (drive) => (drive.tracksPerStep === 2 ? "40" : "80");
const threeDigits = (count) => String(count).padStart(3, "0");
const otherDrive = (driveIndex) => 1 - driveIndex;

/**
 * The media window: two drive fronts and a cassette deck showing what the
 * machine holds, with the controls that belong on them (eject, the 40/80
 * switch, save, the disc surface, the tape transport); under them one
 * searchable list of everything every source offers; and the one-line
 * readouts in the LED panel that open it.
 */
export class MediaWindow {
    constructor({ media, drives, processor, model, modals, loop, visualiser, autoboot, googleDrive }) {
        this.media = media;
        this.drives = drives;
        this.processor = processor;
        this.model = model;
        this.modals = modals;
        this.visualiser = visualiser;
        this.autoboot = autoboot;
        this.googleDrive = googleDrive;

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
                else this.openFor(slot === "tape" ? "tape" : Number(slot));
            });
        this.floating.addEventListener("open", () => this.refreshList());
        drives.addEventListener("disc-changed", (e) => {
            if (e.detail.disc && e.detail.driveIndex === FoldableDrive) this.showDrive(true);
            this.renderDrive(e.detail.driveIndex);
        });
        drives.addEventListener("tracks-changed", (e) => this.renderDrive(e.detail.driveIndex));
        media.addEventListener("tape-changed", (e) => {
            if (e.detail.tape) this.showDeck(true);
            this.renderDeck();
        });
        // The URL is named after the bytes arrive, so the source line catches up here.
        media.addEventListener("media-changed", () => this.renderAll());
        loop.addEventListener("tick", () => this.tick());
        this.showDeck(model.isAtom);
        this.showDrive(false);
        this.showList(true);
        this.setTarget(0);
        this.renderAll();
    }

    get isOpen() {
        return this.floating.isOpen;
    }

    /** Opens with the list, aimed at drive 0. */
    open() {
        this.showList(true);
        this.floating.open();
        this.list.search.select();
        this.list.search.focus();
    }

    /**
     * Opens from a slot's own line: the list is for an empty slot; a full one is
     * being looked at, so the list stays folded until asked for.
     */
    openFor(target) {
        const holds = target === "tape" ? this.processor.tapeInterface.tape : this.processor.fdc?.drives[target]?.disc;
        this.showList(!holds);
        this.floating.open();
        this.aimAt(target);
    }

    close() {
        this.floating.close();
    }

    buildBay(driveIndex) {
        const template = document.getElementById("drive-bay-template");
        const section = template.content.firstElementChild.cloneNode(true);
        this.panel.querySelector(".bays").appendChild(section);
        const upperSide = driveIndex + 2;
        section.dataset.drive = driveIndex;
        section.setAttribute("aria-label", `Drive ${driveIndex}`);
        section.querySelector(".bay-number").textContent = `${driveIndex}/${upperSide}`;
        section.querySelector(".bay-badge").title =
            `Drive ${driveIndex}; the BBC calls the other side of its disc drive ${upperSide}`;
        section.querySelector(".bay-pitch-legend").textContent = `Drive ${driveIndex} reads`;
        const pitch = section.querySelector(".pitch");
        pitch.title = `The 40/80 track switch on the front of drive ${driveIndex}`;
        for (const radio of pitch.querySelectorAll("input")) {
            radio.name = `pitch-${driveIndex}`;
            radio.setAttribute("aria-label", `${radio.value} track`);
            radio.closest("label").title = `Drive ${driveIndex} reads ${radio.value} track discs`;
            radio.addEventListener("change", () =>
                this.drives.setTracksPerStep(driveIndex, radio.value === "40" ? 2 : 1),
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
            save: section.querySelector(".bay-save"),
            surface: section.querySelector(".bay-surface"),
            radios: [...pitch.querySelectorAll("input")],
            busy: null,
            failed: null,
        };
        // The latch ejects a disc, and on an empty drive it is where you would put one in.
        bay.eject.addEventListener("click", () => {
            bay.failed = null;
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
        bay.retry.addEventListener("click", () => this.loadDisc(driveIndex, bay.failed.descriptor));
        section
            .querySelector(".bay-save-ssd")
            .addEventListener("click", () => this.drives.downloadSsdOrDsd(driveIndex));
        section.querySelector(".bay-save-hfe").addEventListener("click", () => this.drives.downloadHfe(driveIndex));
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
            busy: null,
            failed: null,
        };
        deck.window.addEventListener("click", () => this.aimAt("tape"));
        deck.eject.addEventListener("click", () => {
            deck.failed = null;
            this.media.ejectTape();
        });
        deck.retry.addEventListener("click", () => this.loadTape(deck.failed.descriptor));
        deck.rewind.addEventListener("click", () => {
            this.processor.tapeInterface.rewindTape();
            this.renderDeck();
        });
        deck.play.addEventListener("click", () => {
            this.processor.atomppia.playTape();
            this.renderDeck();
        });
        deck.stop.addEventListener("click", () => {
            this.processor.atomppia.stopTape();
            this.renderDeck();
        });
        deck.bar.addEventListener("click", () => this.showDeck(true));
        document.getElementById("deck-hide").addEventListener("click", () => this.showDeck(false));
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
            connect: document.getElementById("media-connect-drive"),
            descriptors: [],
            failures: [],
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
                toast(await this.media.openFile(file, this.target === "tape" ? 0 : this.target), { title: "Opened" });
                this.close();
            } catch (error) {
                reportLoadFailure(file.name, error);
            }
            evt.target.value = "";
        });
        list.connect.addEventListener("click", async () => {
            if (await this.googleDrive.connect()) this.refreshList();
        });
        list.bar.addEventListener("click", () => {
            this.showList(true);
            this.list.search.focus();
        });
        list.hide.addEventListener("click", () => this.showList(false));
        for (const button of list.into.querySelectorAll("[data-target]"))
            button.addEventListener("click", () =>
                this.aimAt(button.dataset.target === "tape" ? "tape" : Number(button.dataset.target)),
            );
        return list;
    }

    /** Points the list at a slot: what Enter on a row loads into. */
    aimAt(target) {
        if (target === "tape") this.showDeck(true);
        else if (target === FoldableDrive) this.showDrive(true);
        this.setTarget(target);
        if (this.list.shown) this.list.search.focus();
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
        for (const button of this.list.into.querySelectorAll("[data-target]"))
            button.classList.toggle("active", button.dataset.target === String(target));
        this.list.hint.replaceChildren(
            ...[
                ["Enter", `loads into ${into}`],
                ...(forTape ? [] : [["Shift+Enter", "loads and boots"]]),
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

    async refreshList() {
        const { descriptors, failures } = await this.media.listAll();
        this.list.descriptors = descriptors;
        this.list.failures = failures;
        this.list.loaded = true;
        this.list.connect.hidden = this.googleDrive.connected;
        this.renderChips();
        this.renderList();
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
            .map((d) => ({ d, score: scoreQuery(d, list.query) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ d }) => d);
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
        const target = d.kind === "tape" ? "tape" : this.target === "tape" ? 0 : this.target;
        const targetName = target === "tape" ? "the cassette deck" : `drive ${target}`;
        const sourceName = Sources[d.source]?.name ?? d.source;
        const label = [d.title, d.publisher, d.detail, sourceName].filter(Boolean).join(", ");
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
        const inDrive = this.slotHolding(d.ref);
        if (inDrive !== null) detail.append(detail.textContent ? " · " : "", cell("in-drive", `in ${inDrive}`));
        const source = cell(`media-source src-${d.source}`, sourceName);
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

    /** Which slot a reference is loaded in, as text, or null. */
    slotHolding(ref) {
        for (const driveIndex of [0, 1])
            if (this.media.params[DriveKeys[driveIndex]] === ref && this.processor.fdc?.drives[driveIndex].disc)
                return `drive ${driveIndex}`;
        if (this.media.params.tape === ref && this.processor.tapeInterface.tape) return "the deck";
        return null;
    }

    /** Where a row's own action sends its descriptor: the deck for a tape, the aimed drive for a disc. */
    rowTarget(d) {
        return d.kind === "tape" ? "tape" : this.target === "tape" ? 0 : this.target;
    }

    loadInto(target, d, options = {}) {
        if (d.kind === "tape") return this.loadTape(d);
        return this.loadDisc(target, d, options);
    }

    /** A reference the URL can carry, or nothing for a file opened this session. */
    static urlRef(d) {
        return d.source === "session" ? undefined : d.ref;
    }

    /** @param {object} [options] `boot`: reset and boot the disc afterwards, whatever the autoboot tick says */
    async loadDisc(driveIndex, d, { boot = false } = {}) {
        noteEvent("media", "loadDisc", d.ref);
        const bay = this.bays[driveIndex];
        bay.busy = d;
        bay.failed = null;
        this.renderDrive(driveIndex);
        const needsAutoboot = driveIndex === 0 && (boot || this.media.params.autoboot !== undefined);
        if (needsAutoboot) this.processor.reset(true);
        try {
            const loaded = await this.media.loadDiscImage(d.ref, this.drives.layoutForDrive(driveIndex));
            bay.busy = null;
            this.drives.putDiscIn(driveIndex, loaded);
            this.media.setDiscImage(driveIndex, MediaWindow.urlRef(d));
            if (needsAutoboot) this.autoboot(d.title);
            // Loaded is what the window was open for.
            this.close();
        } catch (error) {
            bay.busy = null;
            bay.failed = { descriptor: d, error };
            reportLoadFailure(`${d.title} from ${Sources[d.source]?.name ?? d.source}`, error);
        }
        this.renderDrive(driveIndex);
        this.renderList();
    }

    async loadTape(d) {
        noteEvent("media", "loadTape", d.ref);
        const { deck } = this;
        deck.busy = d;
        deck.failed = null;
        this.showDeck(true);
        this.renderDeck();
        try {
            const tape = await this.media.loadTapeImage(d.ref);
            deck.busy = null;
            this.media.setProcessorTape(tape);
            this.media.setTapeImage(MediaWindow.urlRef(d));
            this.close();
        } catch (error) {
            deck.busy = null;
            deck.failed = { descriptor: d, error };
            reportLoadFailure(`${d.title} from ${Sources[d.source]?.name ?? d.source}`, error);
        }
        this.renderDeck();
        this.renderList();
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
        this.list.shown = shown;
        this.panel.classList.toggle("list-collapsed", !shown);
        this.list.bar.setAttribute("aria-expanded", String(shown));
    }

    renderAll() {
        for (const bay of this.bays) this.renderDrive(bay.driveIndex);
        this.renderDeck();
    }

    renderDrive(driveIndex) {
        const bay = this.bays[driveIndex];
        const drive = this.processor.fdc?.drives[driveIndex];
        const disc = drive?.disc;
        const readout = this.readouts[driveIndex];
        bay.section.dataset.state = bay.busy ? "busy" : disc ? "loaded" : "empty";
        for (const radio of bay.radios) {
            radio.checked = !!drive && radio.value === tracksOf(drive);
            radio.disabled = !drive;
        }
        for (const control of [bay.save, bay.surface]) control.disabled = !disc || !!bay.busy;
        bay.eject.disabled = !!bay.busy;
        bay.fail.textContent = bay.failed
            ? `could not load ${bay.failed.descriptor.title}: ${errorText(bay.failed.error)}`
            : "";
        bay.retry.hidden = !bay.failed;
        if (bay.busy) {
            bay.status.textContent = `loading ${bay.busy.title} from ${Sources[bay.busy.source]?.name ?? bay.busy.source}…`;
            bay.kept.textContent = "";
        } else if (!disc) {
            bay.eject.title = `Drive ${driveIndex} is empty; click to pick a disc for it from the list`;
            bay.slot.title = `Drive ${driveIndex} is empty; click to pick a disc for it from the list`;
            bay.status.textContent = drive ? `nothing loaded · reads ${tracksOf(drive)} track discs` : "no drive";
            bay.kept.textContent = "";
            bay.barName.textContent = "empty";
            readout.querySelector(".name").textContent = "empty";
            readout.title = `Drive ${driveIndex} is empty. Click to open the media window`;
        } else {
            const tracks = tracksOf(drive);
            const sides = disc.isDoubleSided ? `2 sides (drives ${driveIndex} and ${driveIndex + 2})` : "1 side";
            const source = sourceOf(
                this.media.params[DriveKeys[driveIndex]] ?? (driveIndex === 0 && this.media.params.disc),
            );
            const catalogue = dfsCatalogue(disc);
            bay.title.textContent = disc.name;
            bay.dfs.textContent = catalogue?.title ? `${catalogue.title} (${catalogue.cycle})` : "";
            bay.dfs.hidden = !catalogue?.title;
            bay.sub.textContent = [`${tracks} track`, sides, source].filter(Boolean).join(" · ");
            bay.status.textContent = [`${tracks}T`, sides, source].filter(Boolean).join(" · ");
            bay.kept.textContent = disc.savesChanges ? "· keeps changes" : "· changes are not being kept";
            bay.kept.classList.toggle("warn", !disc.savesChanges);
            bay.kept.title = disc.savesChanges
                ? "Writes to this disc are saved where it came from"
                : "Writes to this disc are lost when the page reloads; use Save to keep a copy";
            bay.eject.title = `Eject ${disc.name} from drive ${driveIndex}`;
            bay.slot.title = `${disc.name} is in drive ${driveIndex}; click to pick something else for it`;
            bay.barName.textContent = disc.name;
            readout.querySelector(".name").textContent = disc.name;
            readout.title = `Drive ${driveIndex} holds ${disc.name}, ${tracks} track. Click to open the media window`;
        }
        this.showSummary();
    }

    renderDeck() {
        const { deck } = this;
        const tape = this.processor.tapeInterface.tape;
        const isAtom = this.model.isAtom;
        const motorOn = !!this.processor.tapeInterface.motorOn;
        const readout = this.readouts.tape;
        deck.section.classList.toggle("busy", !!deck.busy);
        deck.cassette.hidden = !tape;
        deck.empty.hidden = !!tape;
        deck.rewind.disabled = !tape;
        deck.eject.disabled = !tape || !!deck.busy;
        deck.play.disabled = !tape || !isAtom;
        deck.stop.disabled = !tape || !isAtom;
        deck.play.setAttribute("aria-pressed", String(motorOn));
        deck.play.title = isAtom ? "Play the tape" : "Play stays down: the BBC switches the motor itself, with *MOTOR";
        deck.stop.title = isAtom ? "Stop the tape" : "The BBC switches the motor itself, with *MOTOR";
        deck.fail.textContent = deck.failed
            ? `could not load ${deck.failed.descriptor.title}: ${errorText(deck.failed.error)}`
            : "";
        deck.retry.hidden = !deck.failed;
        if (deck.busy) {
            deck.status.textContent = `loading ${deck.busy.title} from ${Sources[deck.busy.source]?.name ?? deck.busy.source}…`;
        } else if (!tape) {
            deck.window.title = "The deck is empty; click to pick a tape for it from the list";
            deck.eject.title = "Nothing to eject";
            deck.status.textContent = "nothing loaded";
            deck.barName.textContent = "empty";
            readout.querySelector(".name").textContent = "empty";
            readout.title = "The cassette deck is empty. Click to open the media window";
        } else {
            const source = sourceOf(this.media.params.tape);
            deck.title.textContent = tape.name;
            deck.sub.textContent = source ?? "";
            deck.window.title = `${tape.name} is in the deck; click to pick another tape for it`;
            deck.eject.title = `Eject ${tape.name}`;
            deck.status.textContent = [tape.name, source, motorOn ? "motor on" : "stopped"].filter(Boolean).join(" · ");
            deck.barName.textContent = tape.name;
            readout.querySelector(".name").textContent = tape.name;
            readout.title = `The cassette deck holds ${tape.name}. Click to open the media window`;
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
        if (reading === this.lastCounter) return;
        this.lastCounter = reading;
        const digits = threeDigits(reading);
        this.deck.counter.querySelectorAll("b").forEach((digit, i) => (digit.textContent = digits[i]));
        this.deck.counter.setAttribute("aria-label", `Tape counter ${digits}`);
        this.readouts.tape.querySelector(".counter").textContent = this.processor.tapeInterface.tape ? digits : "";
    }

    /** Cheap enough to run every emulation tick: the lights, the reels and the counter. */
    tick() {
        const { tapeInterface, fdc } = this.processor;
        const motorOn = !!(tapeInterface.tape && tapeInterface.motorOn);
        if (motorOn !== this.deck.section.classList.contains("motor")) {
            this.deck.section.classList.toggle("motor", motorOn);
            this.deck.data.classList.toggle("on", motorOn);
            this.readouts.tape.classList.toggle("motor", motorOn);
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
