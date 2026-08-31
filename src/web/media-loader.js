import * as utils from "../utils.js";
import * as disc from "../fdc.js";
import { DiscLayout } from "../disc.js";
import { loadTapeFromData } from "../tapes.js";
import { toast } from "./toast.js";
import { errorText, reportIgnoredFiles, reportLoadFailure, unzipAndReport } from "./reporting.js";

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

export function splitImage(image) {
    const match = image.match(/(([^:]+):\/?\/?|[!^|])?(.*)/);
    const schema = match[2] || match[1] || "";
    image = match[3];
    return { image: image, schema: schema };
}

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
export class MediaLoader {
    /**
     * @param {object} deps
     * @param {object} deps.sources fetchers keyed by schema: sth, tapeSth and hfe
     *   resolve an archive name to image data; drive loads a Google Drive file
     * @param {Function} deps.isSnapshotFile says whether a dropped file is a save state
     * @param {Function} deps.loadSnapshot restores a dropped save state
     */
    constructor({ processor, model, drives, urlState, config, modals, sources, isSnapshotFile, loadSnapshot }) {
        this.processor = processor;
        this.model = model;
        this.drives = drives;
        this.urlState = urlState;
        this.config = config;
        this.modals = modals;
        this.sources = sources;

        document.getElementById("disc_load").addEventListener("change", async (evt) => {
            if (evt.target.files.length === 0) return;
            utils.noteEvent("local", "click"); // NB no filename here
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
            utils.noteEvent("local", "click"); // NB no filename here
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
            utils.noteEvent("local", "clickTape"); // NB no filename here

            try {
                let tapeData = await readFileAsBinaryString(file);
                let tapeName = file.name;
                if (/\.zip/i.test(tapeName)) {
                    const unzipped = await unzipAndReport(utils.stringToUint8Array(tapeData));
                    tapeData = unzipped.data;
                    tapeName = unzipped.name;
                }
                this.setProcessorTape(await loadTapeFromData(tapeName, tapeData, model));
                delete this.params.tape;
                urlState.updateUrl();
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
            utils.noteEvent("local", "drop");
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
                utils.noteEvent("images", "click", image.file);
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

    /** Route tape to the correct interface (ACIA for BBC, PPIA for Atom) */
    setProcessorTape(tape) {
        if (this.model.isAtom) {
            this.processor.atomppia.setTape(tape);
        } else {
            this.processor.acia.setTape(tape);
        }
    }

    setDisc1Image(name) {
        delete this.params.disc;
        this.params.disc1 = name;
        this.urlState.updateUrl();
        this.config.dispatchEvent(new CustomEvent("media-changed", { detail: { disc1: name } }));
    }

    setDisc2Image(name) {
        this.params.disc2 = name;
        this.urlState.updateUrl();
        this.config.dispatchEvent(new CustomEvent("media-changed", { detail: { disc2: name } }));
    }

    setTapeImage(name) {
        this.params.tape = name;
        this.urlState.updateUrl();
        this.config.dispatchEvent(new CustomEvent("media-changed", { detail: { tape: name } }));
    }

    async loadHTMLFile(file) {
        const imageData = utils.stringToUint8Array(await readFileAsBinaryString(file));
        const loadedDisc = disc.discFor(
            this.processor.fdc,
            file.name,
            imageData,
            undefined,
            this.drives.layoutForDrive(0),
        );
        // Local file: retain the image bytes for embedding in save-to-file snapshots.
        loadedDisc.setOriginalImage(imageData);
        this.drives.putDiscIn(0, loadedDisc);
        delete this.params.disc;
        delete this.params.disc1;
        this.urlState.updateUrl();
        this.modals.hide("discs");
    }

    async loadSCSIFile(file) {
        const binaryData = await readFileAsBinaryString(file);
        const { processor } = this;
        processor.filestore.scsi = utils.stringToUint8Array(binaryData);

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
        const split = splitImage(discImage);
        discImage = split.image;
        const schema = split.schema;
        if (schema[0] === "!" || schema === "local") {
            return disc.localDisc(this.processor.fdc, discImage, layout, (error) =>
                toast(
                    `Browser storage would not take changes to ${discImage} (${errorText(error)}). Use Discs, Download to keep a copy.`,
                    { title: "Disc", quietKey: "quietLocalDiscSaveFailed" },
                ),
            );
        }
        // TODO: come up with a decent UX for passing an 'onChange' parameter to each of these.
        // Consider:
        // * hashing contents and making a local disc image named by original disc hash, save by that, and offer
        //   to load the modified disc on load.
        // * popping up a message that notes the disc has changed, and offers a way to make a local image
        // * Dialog box (ugh) saying "is this ok?"
        switch (schema) {
            case "|":
            case "sth": {
                const { name, data, ignored } = await this.sources.sth(discImage);
                reportIgnoredFiles(name, ignored);
                return disc.discFor(this.processor.fdc, name, data, undefined, layout);
            }

            case "hfe":
                return disc.discFor(
                    this.processor.fdc,
                    discImage,
                    await this.sources.hfe(discImage),
                    undefined,
                    layout,
                );

            case "gd": {
                const splat = discImage.match(/([^/]+)\/?(.*)/);
                let name = "(unknown)";
                if (splat) {
                    discImage = splat[1];
                    name = splat[2];
                }
                return this.sources.drive({ name, id: discImage }, layout);
            }
            case "b64data":
                return disc.discFor(this.processor.fdc, "disk.ssd", atob(discImage), undefined, layout);

            case "data": {
                const arr = Array.prototype.map.call(atob(discImage), (x) => x.charCodeAt(0));
                const { name, data } = await unzipAndReport(arr);
                return disc.discFor(this.processor.fdc, name, data, undefined, layout);
            }
            case "http":
            case "https":
            case "file": {
                const asUrl = `${schema}://${discImage}`;
                // url may end in query params etc, which can upset the DSD/SSD etc detection on the extension.
                discImage = new URL(asUrl).pathname;
                let discData = await utils.loadData(asUrl);
                if (/\.zip/i.test(discImage)) {
                    const unzipped = await unzipAndReport(discData);
                    discData = unzipped.data;
                    discImage = unzipped.name;
                }
                return disc.discFor(this.processor.fdc, discImage, discData, undefined, layout);
            }
            default:
                return disc.discFor(
                    this.processor.fdc,
                    discImage,
                    await disc.load("discs/" + discImage),
                    undefined,
                    layout,
                );
        }
    }

    async loadTapeImage(tapeImage) {
        if (!tapeImage) return null;
        const split = splitImage(tapeImage);
        tapeImage = split.image;
        const schema = split.schema;

        switch (schema) {
            case "|":
            case "sth": {
                const { name, data, ignored } = await this.sources.tapeSth(tapeImage);
                reportIgnoredFiles(name, ignored);
                return await loadTapeFromData(name, data, this.model);
            }

            case "data": {
                const arr = Array.prototype.map.call(atob(tapeImage), (x) => x.charCodeAt(0));
                const { name, data } = await unzipAndReport(arr);
                return await loadTapeFromData(name, data, this.model);
            }

            case "http":
            case "https":
            case "file": {
                const asUrl = `${schema}://${tapeImage}`;
                // url may end in query params etc, which can upset file handling
                tapeImage = new URL(asUrl).pathname;
                let tapeData = await utils.loadData(asUrl);
                if (/\.zip/i.test(tapeImage)) {
                    const unzipped = await unzipAndReport(tapeData);
                    tapeData = unzipped.data;
                    tapeImage = unzipped.name;
                }
                return await loadTapeFromData(tapeImage, tapeData, this.model);
            }

            default: {
                const tapePath = "tapes/" + tapeImage;
                let tapeData = await utils.loadData(tapePath);
                let tapeName = tapeImage;
                if (/\.zip/i.test(tapeName)) {
                    const unzipped = await unzipAndReport(tapeData);
                    tapeData = unzipped.data;
                    tapeName = unzipped.name;
                }
                return await loadTapeFromData(tapeName, tapeData, this.model);
            }
        }
    }
}
