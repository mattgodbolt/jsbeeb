import * as disc from "../fdc.js";
import { DiscLayout } from "../disc.js";
import { downloadBlob } from "./dom-utils.js";
import {
    createSnapshot,
    restoreSnapshot,
    snapshotToJSON,
    snapshotFromJSON,
    isSameModel,
    hasCoProcessor,
} from "../snapshot.js";
import { isBemSnapshot, parseBemSnapshot } from "../bem-snapshot.js";
import { isUefSnapshot, parseUefSnapshot } from "../uef-snapshot.js";

const PendingStateKey = "jsbeeb-pending-state";

/** Enough for the restored OS to settle before the user sees the screen. */
const PostRestoreCycles = 40000;

async function compressBlob(blob) {
    const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).blob();
}

async function decompressBlob(blob) {
    const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).blob();
}

export function isSnapshotFile(filename, arrayBuffer) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".snp") || lower.endsWith(".json") || lower.endsWith(".json.gz") || lower.endsWith(".gz"))
        return true;
    // .uef can be either a BeebEm save state or a regular tape image - check content
    if (lower.endsWith(".uef") && arrayBuffer) return isUefSnapshot(arrayBuffer);
    return false;
}

/** The saved snapshot in whichever of the formats we read the buffer holds. */
async function readSnapshot(arrayBuffer) {
    if (isBemSnapshot(arrayBuffer)) return await parseBemSnapshot(arrayBuffer);
    if (isUefSnapshot(arrayBuffer)) return parseUefSnapshot(arrayBuffer);
    // Detect gzip (magic bytes 0x1f 0x8b) or plain JSON
    const bytes = new Uint8Array(arrayBuffer);
    let text;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const decompressed = await decompressBlob(new Blob([arrayBuffer]));
        text = await decompressed.text();
    } else {
        text = new TextDecoder().decode(arrayBuffer);
    }
    return snapshotFromJSON(text);
}

/**
 * What a snapshot needs to put the same discs back: their URL references
 * where they have one, the image bytes where they do not, and CRCs for
 * saying when a source has changed underneath a state.
 */
export function snapshotMedia(slots) {
    const manifest = {};
    for (const slot of slots.driveSlots) {
        const driveDisc = slot.media;
        if (!driveDisc) continue;
        const discKey = slot.index === 0 ? "disc1" : "disc2";
        // A disc with its bytes to hand is embedded below; anything else is known by its reference,
        // which the page's own boot disc has even though the URL does not name it.
        if (!driveDisc.originalImageData && slot.ref) manifest[discKey] = slot.ref;
        if (driveDisc.originalImageCrc32 == null) continue;
        const crcKey = discKey + "Crc32";
        manifest[crcKey] = driveDisc.originalImageCrc32;
        // The snapshot's dirty tracks are indexed by physical track, so restoring has to lay
        // the disc out the way this one was rather than work it out again.
        manifest[discKey + "Layout"] = driveDisc.is40Track ? DiscLayout.expanded40 : DiscLayout.contiguous;
        if (!manifest[discKey] && driveDisc.originalImageData) {
            manifest[discKey + "ImageData"] = driveDisc.originalImageData;
            manifest[discKey + "Name"] = driveDisc.name;
        }
    }
    return Object.keys(manifest).length > 0 ? manifest : undefined;
}

/** Saving and restoring states: the menu item, the file input and the reload across a model change. */
export class SnapshotUI {
    constructor({ processor, model, video, media, urlState, modals, loop }) {
        this.processor = processor;
        this.model = model;
        this.video = video;
        this.media = media;
        this.slots = media.slots;
        this.urlState = urlState;
        this.modals = modals;
        this.loop = loop;

        document.getElementById("save-state").addEventListener("click", async (event) => {
            event.preventDefault();
            await this.saveState();
        });

        document.getElementById("load-state").addEventListener("change", async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = "";
            await this.loadStateFromFile(file);
        });
    }

    async saveState() {
        const resume = this.loop.pause("saving state");
        try {
            const manifest = snapshotMedia(this.slots);
            const snapshot = createSnapshot(this.processor, this.model, manifest);
            const json = snapshotToJSON(snapshot);
            const blob = await compressBlob(new Blob([json]));
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadBlob(blob, `jsbeeb-${this.model.name}-${timestamp}.json.gz`);
        } catch (e) {
            this.modals.showError("saving state", e);
        } finally {
            resume();
        }
    }

    async loadStateFromFile(file, preReadBuffer) {
        const resume = this.loop.pause("loading state");
        try {
            const arrayBuffer = preReadBuffer || (await file.arrayBuffer());
            const snapshot = await readSnapshot(arrayBuffer);
            if (!isSameModel(snapshot.model, this.model.name) || hasCoProcessor(snapshot) !== this.processor.hasTube) {
                // Model or co-processor mismatch: stash state and reload with a matching machine
                sessionStorage.setItem(PendingStateKey, snapshotToJSON(snapshot));
                window.location.href = this.urlState.urlWith({
                    model: snapshot.model,
                    coProcessor: hasCoProcessor(snapshot),
                });
                return true;
            }
            await this.restore(snapshot);
            // Force a repaint so the display updates even while paused
            this.video.paint();
            return true;
        } catch (e) {
            this.modals.showError("loading state", e);
            return false;
        } finally {
            resume();
        }
    }

    /** Picks up the state a cross-model reload stashed, once the matching machine is up. */
    async restorePendingState() {
        const pendingState = sessionStorage.getItem(PendingStateKey);
        if (!pendingState) return;
        sessionStorage.removeItem(PendingStateKey);
        try {
            await this.restore(snapshotFromJSON(pendingState));
            this.processor.execute(PostRestoreCycles);
        } catch (e) {
            this.modals.showError("restoring saved state", e);
        }
    }

    async restore(snapshot) {
        // Order matters: reload disc media first so the base disc is in the
        // drive before restoreSnapshot applies dirty track overlays on top.
        await this.reloadSnapshotMedia(snapshot.media);
        restoreSnapshot(this.processor, this.model, snapshot);
        // The drives' pitch and the recorder's latch came back with the state, behind the slots' backs.
        this.slots.restored();
    }

    async reloadSnapshotMedia(savedMedia) {
        if (!savedMedia) return;
        for (let driveIndex = 0; driveIndex < 2; driveIndex++) {
            const discKey = driveIndex === 0 ? "disc1" : "disc2";
            const imageDataKey = discKey + "ImageData";
            const crcKey = discKey + "Crc32";

            // A snapshot from before layout detection has no field, and was contiguous.
            const layout = savedMedia[discKey + "Layout"] ?? DiscLayout.contiguous;

            let loadedDisc = null;
            if (savedMedia[discKey]) {
                // URL-based disc — reload from source
                loadedDisc = await this.media.loadDiscImage(savedMedia[discKey], layout);
            } else if (savedMedia[imageDataKey]) {
                // Locally-loaded disc — reconstruct from embedded image data
                const imageData =
                    savedMedia[imageDataKey] instanceof Uint8Array
                        ? savedMedia[imageDataKey]
                        : new Uint8Array(Object.values(savedMedia[imageDataKey]));
                const discName = savedMedia[discKey + "Name"] || "snapshot.ssd";
                loadedDisc = disc.discFor(discName, imageData, undefined, layout);
                // Retain the image bytes so subsequent saves can re-embed them.
                loadedDisc.setOriginalImage(imageData);
            }
            if (!loadedDisc) {
                if (savedMedia[crcKey] != null) {
                    // A state may name no source (older default-boot saves); the disc
                    // already in the drive can still satisfy the CRC, but only laid out
                    // the way the state's dirty tracks expect.
                    const currentDisc = this.processor.fdc.drives[driveIndex].disc;
                    const currentLayout = currentDisc?.is40Track ? DiscLayout.expanded40 : DiscLayout.contiguous;
                    if (
                        currentDisc &&
                        currentDisc.originalImageCrc32 === savedMedia[crcKey] &&
                        currentLayout === layout
                    )
                        continue;
                    const problem = savedMedia[discKey]
                        ? `The disc for drive ${driveIndex} (${savedMedia[discKey]}) could not be reloaded`
                        : `This state does not record where the disc in drive ${driveIndex} came from`;
                    throw new Error(
                        `${problem}, and the drive does not hold a matching disc. ` +
                            `Load the right disc, then load the state again.`,
                    );
                }
                continue;
            }

            // A disc that keeps its changes at its source has moved on by design; the state's own
            // dirty tracks go back over it.
            if (
                !loadedDisc.savesChanges &&
                savedMedia[crcKey] != null &&
                loadedDisc.originalImageCrc32 != null &&
                loadedDisc.originalImageCrc32 !== savedMedia[crcKey]
            ) {
                throw new Error(
                    `${loadedDisc.name} has changed since this state was saved, so the state cannot be restored over it.`,
                );
            }

            // An embedded disc has no reference, which takes whatever the URL named before out of it.
            this.slots.put(this.slots.drive(driveIndex), loadedDisc, savedMedia[discKey]);
        }
    }
}
