import * as disc from "../fdc.js";
import { localDisc } from "./local-disc.js";
import { DiscLayout } from "../disc.js";
import { loadTapeFromData } from "../tapes.js";
import { toast } from "./toast.js";
import { errorText, reportIgnoredFiles, reportLoadFailure } from "./reporting.js";
import { MediaResolver, openIfZip, splitImage } from "../media-resolver.js";
import { stringToUint8Array } from "../binary.js";
import { noteEvent } from "./analytics.js";

/** The images offered on the Discs dialog's built-in list. */
export const BuiltInImages = [
    {
        name: "Elite",
        desc: "An 8-bit classic. Hit F10 to launch from the space station, then use <, >, S, X and A to fly around.",
        file: "elite.ssd",
    },
    {
        name: "Welcome",
        desc: "The disc supplied with BBC Disc systems to demonstrate some of the features of the system.",
        file: "Welcome.ssd",
    },
    {
        name: "Music 5000",
        desc: "The Music 5000 system disk and demo songs.",
        file: "5000mstr36008.ssd",
    },
];

function readFileAsBinaryString(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            resolve(e.target.result);
        };
        reader.onerror = (e) => {
            console.error(`Error reading file ${file.name}:`, e);
            reject(new Error(`Failed to read file ${file.name}`));
        };
        reader.readAsBinaryString(file);
    });
}

/**
 * Getting discs and tapes into the machine: resolving any image reference the
 * URL schema can name, the local file inputs, the drop zone and the built-in
 * list. Choosing what goes in a drive funnels through drives.putDiscIn.
 */
export class MediaLoader extends EventTarget {
    /**
     * @param {object} deps
     * @param {Function} deps.isSnapshotFile says whether a dropped file is a save state
     * @param {Function} deps.loadSnapshot restores a dropped save state
     */
    constructor({ processor, model, drives, urlState, modals, isSnapshotFile, loadSnapshot }) {
        super();
        this.processor = processor;
        this.model = model;
        this.drives = drives;
        this.urlState = urlState;
        this.modals = modals;
        this.resolver = new MediaResolver();
        this.driveSource = null;

        document.getElementById("disc_load").addEventListener("change", async (evt) => {
            if (evt.target.files.length === 0) return;
            noteEvent("local", "click"); // NB no filename here
            const file = evt.target.files[0];
            try {
                await this.loadHTMLFile(file);
            } catch (error) {
                reportLoadFailure(file.name, error);
            }
            evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
        });

        document.getElementById("fs_load").addEventListener("change", async (evt) => {
            if (evt.target.files.length === 0) return;
            noteEvent("local", "click"); // NB no filename here
            const file = evt.target.files[0];
            try {
                await this.loadSCSIFile(file);
            } catch (error) {
                reportLoadFailure(file.name, error);
            }
            evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
        });

        document.getElementById("tape_load").addEventListener("change", async (evt) => {
            if (evt.target.files.length === 0) return;
            const file = evt.target.files[0];
            noteEvent("local", "clickTape"); // NB no filename here

            try {
                const { name, data, ignored } = await openIfZip(
                    file.name,
                    stringToUint8Array(await readFileAsBinaryString(file)),
                );
                reportIgnoredFiles(name, ignored);
                this.setProcessorTape(await loadTapeFromData(name, data, model));
                urlState.set({ tape: undefined });
                modals.hide("tapes");
            } catch (error) {
                reportLoadFailure(file.name, error);
            }

            evt.target.value = ""; // clear so if the user picks the same file again after a reset we get a "change"
        });

        const pastetext = document.getElementById("paste-text");
        pastetext.addEventListener("dragover", (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
        });
        pastetext.addEventListener("drop", async (event) => {
            noteEvent("local", "drop");
            const file = event.dataTransfer.files[0];
            if (!file) return;
            try {
                const arrayBuffer = await file.arrayBuffer();
                if (isSnapshotFile(file.name, arrayBuffer)) {
                    await loadSnapshot(file, arrayBuffer);
                } else if (file.name.toLowerCase().endsWith(".uef")) {
                    // Regular UEF tape image (not a BeebEm save state)
                    this.setProcessorTape(await loadTapeFromData(file.name, new Uint8Array(arrayBuffer), model));
                    toast(`Loaded ${file.name} as the tape.`, { title: "Dropped" });
                } else {
                    await this.loadHTMLFile(file);
                    toast(`Loaded ${file.name} into drive 0.`, { title: "Dropped" });
                }
            } catch (error) {
                reportLoadFailure(file.name, error);
            }
        });

        const discList = document.getElementById("disc-list");
        const discTemplate = discList.querySelector(".template");
        for (const image of BuiltInImages) {
            const elem = discTemplate.cloneNode(true);
            elem.classList.remove("template");
            discList.appendChild(elem);
            elem.querySelector(".name").textContent = image.name;
            elem.querySelector(".description").textContent = image.desc;
            elem.addEventListener("click", async () => {
                noteEvent("images", "click", image.file);
                this.setDisc1Image(image.file);
                modals.hide("discs");
                try {
                    drives.putDiscIn(0, await this.loadDiscImage(this.params.disc1, drives.layoutForDrive(0)));
                } catch (error) {
                    reportLoadFailure(`${image.name} (${image.file})`, error);
                }
            });
        }
    }

    get params() {
        return this.urlState.params;
    }

    /** Register the fetcher behind an image schema; each picker calls this as it is constructed. */
    addSource(schema, fetcher) {
        if (schema === "drive") this.driveSource = fetcher;
        else this.resolver.addSource(schema, fetcher);
    }

    /** Puts a tape in the deck, or empties it; raises "tape-changed" with what the deck now holds. */
    setProcessorTape(tape) {
        this.processor.tapeInterface.setTape(tape);
        this.dispatchEvent(new CustomEvent("tape-changed", { detail: { tape } }));
    }

    ejectDisc(driveIndex) {
        this.drives.eject(driveIndex);
        if (driveIndex === 0) this.setDisc1Image(undefined);
        else this.setDisc2Image(undefined);
    }

    ejectTape() {
        this.setProcessorTape(undefined);
        this.setTapeImage(undefined);
    }

    setDisc1Image(name) {
        this.urlState.set({ disc: undefined, disc1: name });
        this.dispatchEvent(new CustomEvent("media-changed", { detail: { disc1: name } }));
    }

    setDisc2Image(name) {
        this.urlState.set({ disc2: name });
        this.dispatchEvent(new CustomEvent("media-changed", { detail: { disc2: name } }));
    }

    setTapeImage(name) {
        this.urlState.set({ tape: name });
        this.dispatchEvent(new CustomEvent("media-changed", { detail: { tape: name } }));
    }

    async loadHTMLFile(file) {
        const imageData = stringToUint8Array(await readFileAsBinaryString(file));
        const loadedDisc = disc.discFor(file.name, imageData, undefined, this.drives.layoutForDrive(0));
        // Local file: retain the image bytes for embedding in save-to-file snapshots.
        loadedDisc.setOriginalImage(imageData);
        this.drives.putDiscIn(0, loadedDisc);
        this.urlState.set({ disc: undefined, disc1: undefined });
        this.modals.hide("discs");
    }

    async loadSCSIFile(file) {
        const { processor } = this;
        if (!processor.filestore) return;
        const binaryData = await readFileAsBinaryString(file);
        processor.filestore.scsi = stringToUint8Array(binaryData);

        processor.filestore.PC = 0x400;
        processor.filestore.SP = 0xff;
        processor.filestore.A = 1;
        processor.filestore.emulationSpeed = 0;

        // Reset any open receive blocks
        processor.econet.receiveBlocks = [];
        processor.econet.nextReceiveBlockNumber = 1;

        this.modals.hide("econetfs");
    }

    async loadDiscImage(discImage, layout = DiscLayout.auto) {
        if (!discImage) return null;
        const { schema, image } = splitImage(discImage);
        if (schema[0] === "!" || schema === "local") {
            return localDisc(image, layout, (error) =>
                toast(
                    `Browser storage would not take changes to ${image} (${errorText(error)}). Use Discs, Download to keep a copy.`,
                    { title: "Disc", quietKey: "quietLocalDiscSaveFailed" },
                ),
            );
        }
        if (schema === "gd") {
            const [, id, name = "(unknown)"] = image.match(/([^/]+)\/?(.*)/) ?? [null, image];
            return this.driveSource({ name, id }, layout);
        }
        // TODO(#822) come up with a decent UX for passing an 'onChange' parameter to each of these.
        // Consider:
        // * hashing contents and making a local disc image named by original disc hash, save by that, and offer
        //   to load the modified disc on load.
        // * popping up a message that notes the disc has changed, and offers a way to make a local image
        // * Dialog box (ugh) saying "is this ok?"
        const { name, data, ignored } = await this.resolver.resolve("disc", discImage);
        reportIgnoredFiles(name, ignored);
        return disc.discFor(name, data, undefined, layout);
    }

    async loadTapeImage(tapeImage) {
        if (!tapeImage) return null;
        const { name, data, ignored } = await this.resolver.resolve("tape", tapeImage);
        reportIgnoredFiles(name, ignored);
        return loadTapeFromData(name, data, this.model);
    }
}
