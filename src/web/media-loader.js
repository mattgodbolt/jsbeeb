import * as disc from "../fdc.js";
import { localDisc } from "./local-disc.js";
import { DiscLayout } from "../disc.js";
import { loadTapeFromData } from "../tapes.js";
import { toast } from "./toast.js";
import { errorText, reportIgnoredFiles, reportLoadFailure } from "./reporting.js";
import { MediaResolver, openIfZip, splitImage } from "../media-resolver.js";
import { stringToUint8Array } from "../binary.js";
import { noteEvent } from "./analytics.js";
import { browserDiscNames, describeBrowserDisc, describeBuiltIn, describeSessionFile } from "./media-catalogue.js";

const isTapeName = (name) => /\.uef$/i.test(name);

/** The example discs that ship with jsbeeb. */
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
 * URL schema can name, files from this computer, and what every source has to
 * offer. Choosing what goes in a drive funnels through drives.putDiscIn.
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
        this.listers = new Map();
        /** Files opened this session, by name: the only media the URL cannot name. */
        this.sessionFiles = new Map();
        this.resolver.addSource("session", (name) => {
            const file = this.sessionFiles.get(name);
            if (!file) throw new Error(`${name} was not opened this session`);
            return { name, data: file.data, ignored: [] };
        });
        this.addLister("builtin", () => BuiltInImages.map(describeBuiltIn));
        this.addLister("browser", () => browserDiscNames().map(describeBrowserDisc));
        this.addLister("session", () =>
            [...this.sessionFiles].map(([name, file]) => describeSessionFile(name, file.kind)),
        );

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
                toast(await this.openFile(file), { title: "Dropped" });
            } catch (error) {
                reportLoadFailure(file.name, error);
            }
        });
        this.isSnapshotFile = isSnapshotFile;
        this.loadSnapshot = loadSnapshot;
    }

    get params() {
        return this.urlState.params;
    }

    /** Register the fetcher behind an image schema; each picker calls this as it is constructed. */
    addSource(schema, fetcher) {
        if (schema === "drive") this.driveSource = fetcher;
        else this.resolver.addSource(schema, fetcher);
    }

    /**
     * Register what a source has to offer the media window: a function returning
     * descriptors (see media-catalogue.js), fetched when the window asks.
     */
    addLister(source, lister) {
        this.listers.set(source, lister);
    }

    /**
     * Everything every source offers, merged. A source that fails is reported
     * and left out rather than taking the rest of the list with it.
     *
     * @returns {Promise<{descriptors: object[], failures: string[]}>}
     */
    async listAll() {
        const descriptors = [];
        const failures = [];
        for (const [source, lister] of this.listers) {
            try {
                descriptors.push(...(await lister()));
            } catch (error) {
                console.error(`Listing ${source} failed:`, error);
                failures.push(`${source}: ${errorText(error)}`);
            }
        }
        return { descriptors, failures };
    }

    /**
     * A file from this computer, into whatever it is for: a save state is
     * restored, a tape goes in the deck, anything else into the named drive.
     *
     * @returns {Promise<string>} what happened, for a toast
     */
    async openFile(file, driveIndex = 0) {
        const arrayBuffer = await file.arrayBuffer();
        if (this.isSnapshotFile(file.name, arrayBuffer)) {
            await this.loadSnapshot(file, arrayBuffer);
            return `Restored the state saved in ${file.name}.`;
        }
        if (isTapeName(file.name)) {
            await this.loadTapeFile(file, new Uint8Array(arrayBuffer));
            return `Loaded ${file.name} as the tape.`;
        }
        await this.loadHTMLFile(file, driveIndex, new Uint8Array(arrayBuffer));
        return `Loaded ${file.name} into drive ${driveIndex}.`;
    }

    /** Puts a tape in the deck, or empties it; raises "tape-changed" with what the deck now holds. */
    setProcessorTape(tape) {
        this.processor.tapeInterface.setTape(tape);
        this.dispatchEvent(new CustomEvent("tape-changed", { detail: { tape } }));
    }

    ejectDisc(driveIndex) {
        this.drives.eject(driveIndex);
        this.setDiscImage(driveIndex, undefined);
    }

    ejectTape() {
        this.setProcessorTape(undefined);
        this.setTapeImage(undefined);
    }

    /** Names the disc in a drive for the URL and the settings store, or unnames it. */
    setDiscImage(driveIndex, name) {
        // The URL has always called the drives disc1 and disc2, and a bare disc means disc1.
        const changes = driveIndex === 0 ? { disc: undefined, disc1: name } : { disc2: name };
        this.urlState.set(changes);
        const detail = driveIndex === 0 ? { disc1: name } : { disc2: name };
        this.dispatchEvent(new CustomEvent("media-changed", { detail }));
    }

    setAutoboot(on) {
        this.urlState.set({ autoboot: on ? true : undefined });
    }

    setTapeImage(name) {
        this.urlState.set({ tape: name });
        this.dispatchEvent(new CustomEvent("media-changed", { detail: { tape: name } }));
    }

    /** A disc image file from this computer, into a drive; the URL cannot name it, so it is unnamed there. */
    async loadHTMLFile(file, driveIndex = 0, imageData = null) {
        if (!imageData) imageData = stringToUint8Array(await readFileAsBinaryString(file));
        const { name, data, ignored } = await openIfZip(file.name, imageData);
        reportIgnoredFiles(name, ignored);
        const loadedDisc = disc.discFor(name, data, undefined, this.drives.layoutForDrive(driveIndex));
        // Local file: retain the image bytes for embedding in save-to-file snapshots.
        loadedDisc.setOriginalImage(data);
        this.sessionFiles.set(name, { data, kind: "disc" });
        this.drives.putDiscIn(driveIndex, loadedDisc);
        this.setDiscImage(driveIndex, undefined);
    }

    /** A tape image file from this computer, into the deck; likewise unnamed in the URL. */
    async loadTapeFile(file, imageData = null) {
        if (!imageData) imageData = stringToUint8Array(await readFileAsBinaryString(file));
        const { name, data, ignored } = await openIfZip(file.name, imageData);
        reportIgnoredFiles(name, ignored);
        this.sessionFiles.set(name, { data, kind: "tape" });
        this.setProcessorTape(await loadTapeFromData(name, data, this.model));
        this.setTapeImage(undefined);
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
                    `Browser storage would not take changes to ${image} (${errorText(error)}). Use the drive's Save button to keep a copy.`,
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
        const loaded = disc.discFor(name, data, undefined, layout);
        if (schema === "session") loaded.setOriginalImage(data);
        return loaded;
    }

    async loadTapeImage(tapeImage) {
        if (!tapeImage) return null;
        const { name, data, ignored } = await this.resolver.resolve("tape", tapeImage);
        reportIgnoredFiles(name, ignored);
        return loadTapeFromData(name, data, this.model);
    }
}
