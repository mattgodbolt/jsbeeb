import * as utils from "../utils.js";
import * as bootstrap from "bootstrap";
import { StairwayToHell } from "../sth.js";
import { errorText } from "./reporting.js";
import { clearArchiveList, filterArchiveList, showArchiveMessage } from "./archive-list.js";

/**
 * The Stairway to Hell archive picker: one modal browsing either the disc or
 * the tape catalogue, filtered as it renders.
 */
export class SthPicker {
    constructor({ media, drives, modals, urlState, processor, autoboot }) {
        this.media = media;
        this.drives = drives;
        this.modals = modals;
        this.urlState = urlState;
        this.processor = processor;
        this.autoboot = autoboot;

        this.modal = new bootstrap.Modal(document.getElementById("sth"));
        document.getElementById("sth").addEventListener("shown.bs.modal", () => {
            document.getElementById("sth-filter").focus();
        });

        // Anything that clears the list takes a new ticket; a chain whose ticket is
        // stale gives up (the same scheme as hfe-picker.js).
        this.renderTicket = 0;

        const startLoad = () => {
            this.renderTicket++;
            showArchiveMessage("sth", "sth-list", "Loading catalog from STH archive");
        };
        const onError = () => {
            this.renderTicket++;
            showArchiveMessage("sth", "sth-list", "There was an error accessing the STH archive");
        };
        this.discs = new StairwayToHell(
            startLoad,
            (cat) => this.renderCatalogue(cat, (item) => this.pickDisc(item)),
            onError,
            false,
        );
        this.tapes = new StairwayToHell(
            startLoad,
            (cat) => this.renderCatalogue(cat, (item) => this.pickTape(item)),
            onError,
            true,
        );
        media.addSource("sth", (name) => this.discs.fetch(name));
        media.addSource("tapeSth", (name) => this.tapes.fetch(name));

        document.addEventListener("click", (e) => {
            const target = e.target.closest("a.sth");
            if (!target) return;
            const type = target.dataset.id;
            if (type === "discs") {
                this.discs.populate();
            } else if (type === "tapes") {
                this.tapes.populate();
            } else {
                console.log("unknown id", type);
            }
        });

        const sthFilter = document.getElementById("sth-filter");
        const applyFilter = () => filterArchiveList("sth-list", sthFilter.value);
        sthFilter.addEventListener("change", applyFilter);
        sthFilter.addEventListener("keyup", applyFilter);
    }

    async pickDisc(item) {
        utils.noteEvent("sth", "click", item);
        const image = "sth:" + item;
        this.media.setDisc1Image(image);
        const needsAutoboot = this.urlState.params.autoboot !== undefined;
        if (needsAutoboot) {
            this.processor.reset(true);
        }

        this.modals.popupLoading("Loading " + item);
        try {
            const loaded = await this.media.loadDiscImage(image, this.drives.layoutForDrive(0));
            this.drives.putDiscIn(0, loaded);
            this.modals.loadingFinished();

            if (needsAutoboot) {
                this.autoboot(item);
            }
        } catch (err) {
            console.error("Error loading disc image:", err);
            this.modals.loadingFinished(`Unable to load ${item} from the STH archive: ${errorText(err)}`);
        }
    }

    async pickTape(item) {
        utils.noteEvent("sth", "clickTape", item);
        const image = "sth:" + item;
        this.media.setTapeImage(image);

        this.modals.popupLoading("Loading " + item);
        try {
            const tape = await this.media.loadTapeImage(image);
            this.media.setProcessorTape(tape);
            this.modals.loadingFinished();
        } catch (err) {
            console.error("Error loading tape image:", err);
            this.modals.loadingFinished(`Unable to load ${item} from the STH archive: ${errorText(err)}`);
        }
    }

    renderCatalogue(cat, onClick) {
        const ticket = ++this.renderTicket;
        clearArchiveList("sth-list");
        const sthList = document.getElementById("sth-list");
        document.querySelector("#sth .loading").style.display = "none";
        const template = sthList.querySelector(".template");

        const doSome = (all) => {
            if (ticket !== this.renderTicket) return;
            const MaxAtATime = 100;
            const Delay = 30;
            const batch = all.slice(0, MaxAtATime);
            const remaining = all.slice(MaxAtATime);
            const filter = document.getElementById("sth-filter").value.toLowerCase();
            for (const name of batch) {
                const row = template.cloneNode(true);
                row.classList.remove("template");
                sthList.appendChild(row);
                row.querySelector(".name").textContent = name;
                row.addEventListener("click", () => {
                    onClick(name);
                    this.modal.hide();
                });
                row.style.display = name.toLowerCase().indexOf(filter) >= 0 ? "" : "none";
            }
            if (remaining.length) setTimeout(() => doSome(remaining), Delay);
        };

        doSome(cat);
    }
}
