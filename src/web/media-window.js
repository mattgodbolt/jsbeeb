import { dfsCatalogue } from "../disc.js";
import { splitImage } from "../media-resolver.js";
import { FloatingPanel } from "./floating-panel.js";

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
};

// The counter has three digits, and a tape run end to end turns it over once.
const CounterDivisions = 1000;

const DriveKeys = ["disc1", "disc2"];

/** Where a URL reference came from, in words, or null when the URL names nothing. */
export function sourceOf(ref) {
    if (!ref) return null;
    return SourceNames[splitImage(ref).schema] ?? null;
}

const tracksOf = (drive) => (drive.tracksPerStep === 2 ? "40" : "80");
const threeDigits = (count) => String(count).padStart(3, "0");

/**
 * The media window: two drive fronts and a cassette deck showing what the
 * machine holds, with the controls that belong on them (eject, the 40/80
 * switch, save, the disc surface, the tape transport), and the one-line
 * readouts in the LED panel that open it.
 */
export class MediaWindow {
    constructor({ media, drives, processor, model, modals, loop, visualiser }) {
        this.media = media;
        this.drives = drives;
        this.processor = processor;
        this.model = model;
        this.modals = modals;
        this.visualiser = visualiser;

        this.panel = document.getElementById("media-panel");
        this.floating = new FloatingPanel({
            panel: this.panel,
            header: this.panel.querySelector(".media-header"),
            closeButton: document.getElementById("media-close"),
        });
        this.summary = document.getElementById("media-summary");
        this.bays = [0, 1].map((driveIndex) => this.buildBay(driveIndex));
        this.deck = this.buildDeck();
        this.readouts = Object.fromEntries(
            [...document.querySelectorAll("#leds .slot-readout")].map((el) => [el.dataset.slot, el]),
        );
        this.counterBase = 0;
        this.lastCounter = null;

        for (const opener of document.querySelectorAll(".media-window-open"))
            opener.addEventListener("click", (e) => {
                e.preventDefault();
                this.open();
            });
        drives.addEventListener("disc-changed", (e) => this.renderDrive(e.detail.driveIndex));
        drives.addEventListener("tracks-changed", (e) => this.renderDrive(e.detail.driveIndex));
        media.addEventListener("tape-changed", () => this.renderDeck());
        // The URL is named after the bytes arrive, so the source line catches up here.
        media.addEventListener("media-changed", () => this.renderAll());
        loop.addEventListener("tick", () => this.tick());
        this.renderAll();
    }

    get isOpen() {
        return this.floating.isOpen;
    }

    open() {
        this.floating.open();
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
            save: section.querySelector(".bay-save"),
            surface: section.querySelector(".bay-surface"),
            radios: [...pitch.querySelectorAll("input")],
        };
        bay.eject.addEventListener("click", () => this.media.ejectDisc(driveIndex));
        bay.slot.addEventListener("click", () => this.modals.show("discs"));
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
            rewind: document.getElementById("tape-rewind"),
            play: document.getElementById("tape-play"),
            stop: document.getElementById("tape-stop"),
            eject: document.getElementById("tape-eject"),
        };
        deck.window.addEventListener("click", () => this.modals.show("tapes"));
        deck.eject.addEventListener("click", () => this.media.ejectTape());
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
        document.getElementById("tape-counter-reset").addEventListener("click", () => {
            this.counterBase = this.tapeCount();
            this.showCounter();
        });
        return deck;
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
        bay.section.dataset.state = disc ? "loaded" : "empty";
        for (const radio of bay.radios) {
            radio.checked = !!drive && radio.value === tracksOf(drive);
            radio.disabled = !drive;
        }
        for (const control of [bay.eject, bay.save, bay.surface]) control.disabled = !disc;
        if (!disc) {
            bay.eject.title = `Nothing to eject from drive ${driveIndex}`;
            bay.slot.title = `Drive ${driveIndex} is empty; click to load a disc`;
            bay.status.textContent = drive ? `nothing loaded · reads ${tracksOf(drive)} track discs` : "no drive";
            bay.kept.textContent = "";
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
            bay.slot.title = `${disc.name} is in drive ${driveIndex}; click to load something else`;
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
        deck.cassette.hidden = !tape;
        deck.empty.hidden = !!tape;
        deck.rewind.disabled = !tape;
        deck.eject.disabled = !tape;
        deck.play.disabled = !tape || !isAtom;
        deck.stop.disabled = !tape || !isAtom;
        deck.play.setAttribute("aria-pressed", String(motorOn));
        deck.play.title = isAtom ? "Play the tape" : "Play stays down: the BBC switches the motor itself, with *MOTOR";
        deck.stop.title = isAtom ? "Stop the tape" : "The BBC switches the motor itself, with *MOTOR";
        if (!tape) {
            deck.window.title = "The deck is empty; click to load a tape";
            deck.eject.title = "Nothing to eject";
            deck.status.textContent = "nothing loaded";
            readout.querySelector(".name").textContent = "empty";
            readout.title = "The cassette deck is empty. Click to open the media window";
        } else {
            const source = sourceOf(this.media.params.tape);
            deck.title.textContent = tape.name;
            deck.sub.textContent = source ?? "";
            deck.window.title = `${tape.name} is in the deck; click to load another tape`;
            deck.eject.title = `Eject ${tape.name}`;
            deck.status.textContent = [tape.name, source, motorOn ? "motor on" : "stopped"].filter(Boolean).join(" · ");
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
