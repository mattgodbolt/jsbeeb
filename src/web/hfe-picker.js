import * as utils from "../utils.js";
import * as bootstrap from "bootstrap";
import { BbcDiscArchive, Provenance, describe as describeHfe, matches, provenancesIn } from "../bbcdiscs.js";
import { errorText } from "./reporting.js";
import { clearArchiveList, showArchiveMessage } from "./archive-list.js";

const HfeProvenanceLabels = {
    [Provenance.Captured]: ["Captured", "Direct from disc"],
    [Provenance.Reconstructed]: ["Reconstructed", "Rebuilt from a sector dump"],
};

const showHfeRow = (row, file, filter, shown) => (row.style.display = matches(file, filter, shown) ? "" : "none");

/**
 * The HFE archive picker: the catalogue with its filter and provenance
 * choices, rendered a batch at a time under a ticket so a list that has been
 * emptied is not appended to by a stale chain.
 */
export class HfePicker {
    constructor({ media, drives, modals, urlState, processor, autoboot }) {
        this.media = media;
        this.drives = drives;
        this.modals = modals;
        this.urlState = urlState;
        this.processor = processor;
        this.autoboot = autoboot;

        // Rendering is spread over several turns of the event loop, so a list that has
        // been emptied may still have a chain of appends heading for it. Anything that
        // clears the list takes a new ticket; a chain whose ticket is stale gives up.
        this.renderTicket = 0;

        this.archive = new BbcDiscArchive(
            () => {
                this.renderTicket++;
                showArchiveMessage("hfe", "hfe-list", "Loading catalogue from HFE archive");
            },
            (catalogue) => this.renderCatalogue(catalogue),
            () => {
                this.renderTicket++;
                showArchiveMessage("hfe", "hfe-list", "There was an error accessing the HFE archive");
            },
        );
        media.addSource("hfe", (path) => this.archive.fetch(path));

        this.modal = new bootstrap.Modal(document.getElementById("hfe"));
        document.getElementById("hfe").addEventListener("shown.bs.modal", () => {
            document.getElementById("hfe-filter").focus();
        });
        document.getElementById("hfe").addEventListener("show.bs.modal", () => this.archive.populate());

        this.filter = document.getElementById("hfe-filter");
        this.provenance = document.getElementById("hfe-provenance");
        const onFilter = () => this.applyFilter();
        this.filter.addEventListener("change", onFilter);
        this.filter.addEventListener("keyup", onFilter);
    }

    async pick(file) {
        utils.noteEvent("hfe", "click", file.path);
        const image = "hfe:" + file.path;
        this.media.setDisc1Image(image);
        const needsAutoboot = this.urlState.params.autoboot !== undefined;
        if (needsAutoboot) this.processor.reset(true);

        const name = describeHfe(file).title;
        this.modals.popupLoading("Loading " + name);
        try {
            const loaded = await this.media.loadDiscImage(image, this.drives.layoutForDrive(0));
            this.drives.putDiscIn(0, loaded);
            this.modals.loadingFinished();
            if (needsAutoboot) this.autoboot(name);
        } catch (err) {
            console.error("Error loading disc image:", err);
            this.modals.loadingFinished(`Unable to load ${name} from the HFE archive: ${errorText(err)}`);
        }
    }

    renderCatalogue(catalogue) {
        const ticket = ++this.renderTicket;
        clearArchiveList("hfe-list");
        const list = document.getElementById("hfe-list");
        document.querySelector("#hfe .loading").style.display = "none";
        const template = list.querySelector(".template");
        this.showProvenanceChoices(catalogue);

        const addSome = (remaining) => {
            if (ticket !== this.renderTicket) return;
            const MaxAtATime = 100;
            const Delay = 30;
            // Read per batch: both can be changed while this is still going.
            const filter = this.filter.value.toLowerCase();
            const shown = this.shownProvenances();
            for (const file of remaining.slice(0, MaxAtATime)) {
                const { title, publisher, detail } = describeHfe(file);
                const row = template.cloneNode(true);
                row.classList.remove("template");
                row.querySelector(".name").textContent = title;
                row.querySelector(".publisher").textContent = publisher;
                row.querySelector(".detail").textContent = detail;
                row.querySelector(".provenance").textContent =
                    file.provenance === Provenance.Reconstructed ? "reconstructed" : "";
                if (file.notes) row.title = file.notes;
                // The row is an anchor, and letting it navigate to "#" would push a
                // history entry of its own on top of the one updateUrl pushes.
                row.addEventListener("click", (event) => {
                    event.preventDefault();
                    this.pick(file);
                    this.modal.hide();
                });
                row.hfeFile = file;
                list.appendChild(row);
                showHfeRow(row, file, filter, shown);
            }
            if (remaining.length > MaxAtATime) setTimeout(() => addSome(remaining.slice(MaxAtATime)), Delay);
        };
        addSome(catalogue);
    }

    /** Which provenances the picker is showing, or null when it is not offering the choice. */
    shownProvenances() {
        const boxes = [...this.provenance.querySelectorAll("input")];
        return boxes.length ? new Set(boxes.filter((box) => box.checked).map((box) => box.value)) : null;
    }

    // Offer one tick per provenance the archive actually holds, rather than naming
    // them here: a source added later should appear without this having to change.
    showProvenanceChoices(catalogue) {
        const present = provenancesIn(catalogue);
        // Nothing to choose between: no ticks, and shownProvenances says "all".
        if (present.length < 2) {
            this.provenance.replaceChildren();
            return;
        }
        const wasShown = this.shownProvenances();
        this.provenance.replaceChildren(
            ...present.map((provenance) => {
                const [text, why] = HfeProvenanceLabels[provenance] ?? [provenance, ""];
                const label = document.createElement("label");
                label.title = why;
                const box = document.createElement("input");
                box.type = "checkbox";
                box.value = provenance;
                box.checked = !wasShown || wasShown.has(provenance);
                box.addEventListener("change", () => this.applyFilter());
                label.append(box, text);
                return label;
            }),
        );
    }

    applyFilter() {
        const filter = this.filter.value.toLowerCase();
        const shown = this.shownProvenances();
        for (const row of document.querySelectorAll("#hfe-list li:not(.template)"))
            showHfeRow(row, row.hfeFile, filter, shown);
    }
}
