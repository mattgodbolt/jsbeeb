import * as disc from "../fdc.js";
import { localDisc } from "./local-disc.js";
import { DiscLayout } from "../disc.js";
import { loadTapeFromData } from "../tapes.js";
import { toast } from "./toast.js";
import { errorText, reportIgnoredFiles, reportLoadFailure } from "./reporting.js";
import { MediaResolver, openIfZip, routeOf, splitImage } from "../media-resolver.js";
import { MediaSlots } from "./media-slots.js";
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
 * offer. What goes in a drive or the deck funnels through its `slots`.
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
        this.isSnapshotFile = isSnapshotFile;
        this.loadSnapshot = loadSnapshot;
        this.slots = new MediaSlots({ loader: this, drives, processor, urlState });
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
    }

    get params() {
        return this.urlState.params;
    }

    /** Register the fetcher behind an image schema; each source calls this as it is constructed. */
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
        const sources = [...this.listers.keys()];
        const outcomes = await Promise.allSettled(sources.map(async (source) => this.listers.get(source)()));
        outcomes.forEach((outcome, i) => {
            if (outcome.status === "fulfilled") {
                descriptors.push(...outcome.value);
            } else {
                console.error(`Listing ${sources[i]} failed:`, outcome.reason);
                failures.push(`${sources[i]}: ${errorText(outcome.reason)}`);
            }
        });
        return { descriptors, failures };
    }

    /**
     * A file from this computer, into whatever it is for: a save state is
     * restored, a tape goes in the deck, anything else into the named drive.
     *
     * @returns {Promise<?{kind: string, name: string, driveIndex?: number, words: string}>} what
     *   happened, with words for a toast; null when a restore failed and has been reported already
     */
    async openFile(file, driveIndex = 0) {
        const arrayBuffer = await file.arrayBuffer();
        if (this.isSnapshotFile(file.name, arrayBuffer)) {
            if (!(await this.loadSnapshot(file, arrayBuffer))) return null;
            return { kind: "snapshot", name: file.name, words: `Restored the state saved in ${file.name}.` };
        }
        // What a zip holds decides whether it is a tape or a disc, so it is opened first.
        const { name, data, ignored } = await openIfZip(file.name, new Uint8Array(arrayBuffer));
        reportIgnoredFiles(name, ignored);
        if (isTapeName(name)) {
            await this.loadTapeFile(name, data);
            return { kind: "tape", name, words: `Loaded ${name} as the tape.` };
        }
        this.loadDiscFile(name, data, driveIndex);
        return { kind: "disc", name, driveIndex, words: `Loaded ${name} into drive ${driveIndex}.` };
    }

    setAutoboot(on) {
        this.urlState.set({ autoboot: on ? true : undefined });
    }

    /** Keeps a file opened this session for the list, and says so with "files-changed". */
    rememberFile(name, data, kind) {
        this.sessionFiles.set(name, { data, kind });
        this.dispatchEvent(new Event("files-changed"));
    }

    /** A disc image from this computer, into a drive; the URL cannot name it, so it is unnamed there. */
    loadDiscFile(name, data, driveIndex) {
        const loadedDisc = disc.discFor(name, data, undefined, this.drives.layoutForDrive(driveIndex));
        // Local file: retain the image bytes for embedding in save-to-file snapshots.
        loadedDisc.setOriginalImage(data);
        this.rememberFile(name, data, "disc");
        this.slots.put(this.slots.drive(driveIndex), loadedDisc, `session:${name}`, { inUrl: false });
    }

    /** A tape image from this computer, into the deck; likewise unnamed in the URL. */
    async loadTapeFile(name, data) {
        const tape = await loadTapeFromData(name, data, this.model);
        this.rememberFile(name, data, "tape");
        this.slots.put(this.slots.deck, tape, `session:${name}`, { inUrl: false });
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
        const { image } = splitImage(discImage);
        const route = routeOf(discImage);
        if (route === "browser") {
            return localDisc(image, layout, (error) =>
                toast(
                    `Browser storage would not take changes to ${image} (${errorText(error)}). Use the drive's Save button to keep a copy.`,
                    { title: "Disc", quietKey: "quietLocalDiscSaveFailed" },
                ),
            );
        }
        if (route === "drive") {
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
        if (route === "session") loaded.setOriginalImage(data);
        return loaded;
    }

    async loadTapeImage(tapeImage) {
        if (!tapeImage) return null;
        const { name, data, ignored } = await this.resolver.resolve("tape", tapeImage);
        reportIgnoredFiles(name, ignored);
        return loadTapeFromData(name, data, this.model);
    }
}
