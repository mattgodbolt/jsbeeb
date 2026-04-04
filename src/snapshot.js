"use strict";

import { typedArrayToBase64, base64ToTypedArray } from "./state-utils.js";
import { findModel } from "./models.js";

const SnapshotFormat = "jsbeeb-snapshot";
const SnapshotVersion = 2;

/**
 * Check if two model names are compatible for state restore.
 * Resolves synonyms via findModel, then compares by compatGroup —
 * models sharing the same hardware (e.g. Master DFS/ADFS/ANFS, or
 * BBC B 8271 DFS 0.9/1.2) are compatible since they differ only
 * in filesystem ROM.
 */
export function modelsCompatible(snapshotModel, currentModel) {
    if (snapshotModel === currentModel) return true;
    const resolvedSnapshot = findModel(snapshotModel);
    const resolvedCurrent = findModel(currentModel);
    if (resolvedSnapshot && resolvedCurrent) {
        if (resolvedSnapshot === resolvedCurrent) return true;
        return resolvedSnapshot.compatGroup === resolvedCurrent.compatGroup;
    }
    return false;
}

// Map of TypedArray constructor names for deserialization
const TypedArrayConstructors = {
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
};

/**
 * Create a snapshot of the emulator state for save-to-file.
 * Disc track pulse data is stripped — on restore, the discs are reloaded
 * from the source references in the `media` field. (The in-memory rewind
 * path uses cpu.snapshotState() directly, which retains full disc data.)
 * @param {import('./6502.js').Cpu6502} cpu
 * @param {object} model - the model definition object
 * @param {object} [media] - optional media source references (disc1, disc2)
 * @returns {object} snapshot object
 */
export function createSnapshot(cpu, model, media) {
    const state = cpu.snapshotState();
    // Strip clean disc track data from the save-to-file snapshot.
    // The FDC/drive mechanical state is kept; only clean tracks
    // (which can be reloaded from the disc image) are removed.
    // Dirty tracks (written since disc load) are kept as an overlay.
    if (state.fdc && state.fdc.drives) {
        for (const drive of state.fdc.drives) {
            if (drive.disc) {
                const dirtyTracks = {};
                for (const key of Object.keys(drive.disc.tracks)) {
                    const [sideStr, trackNumStr] = key.split(":");
                    const isSideUpper = sideStr === "true";
                    const trackNum = parseInt(trackNumStr, 10);
                    const dirtyKey = trackNum | (isSideUpper ? 0x100 : 0);
                    if (drive.disc._everDirtyTracks && drive.disc._everDirtyTracks.has(dirtyKey)) {
                        dirtyTracks[key] = drive.disc.tracks[key];
                    }
                }
                drive.disc.tracks = {};
                drive.disc.dirtyTracks = dirtyTracks;
                // Clean up internal-only fields not needed in serialized state
                delete drive.disc._everDirtyTracks;
                delete drive.disc._originalImageData;
                delete drive.disc._originalImageCrc32;
            }
        }
    }
    const snapshot = {
        format: SnapshotFormat,
        version: SnapshotVersion,
        model: model.name,
        timestamp: new Date().toISOString(),
        state,
    };
    if (media) snapshot.media = media;
    return snapshot;
}

/**
 * Restore emulator state from a snapshot.
 * @param {import('./6502.js').Cpu6502} cpu
 * @param {object} model - the current model definition
 * @param {object} snapshot
 * @throws {Error} if the model doesn't match
 */
export function restoreSnapshot(cpu, model, snapshot) {
    if (snapshot.format !== SnapshotFormat) {
        throw new Error(`Unknown snapshot format: ${snapshot.format}`);
    }
    if (snapshot.version > SnapshotVersion) {
        throw new Error(`Snapshot version ${snapshot.version} is newer than supported version ${SnapshotVersion}`);
    }
    if (!modelsCompatible(snapshot.model, model.name)) {
        throw new Error(`Model mismatch: snapshot is for "${snapshot.model}" but current model is "${model.name}"`);
    }
    cpu.restoreState(snapshot.state);
}

/**
 * Serialize a snapshot to a JSON string, converting TypedArrays to base64.
 * @param {object} snapshot
 * @returns {string} JSON string
 */
export function snapshotToJSON(snapshot) {
    return JSON.stringify(snapshot, (key, value) => {
        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
            return {
                __typedArray: true,
                type: value.constructor.name,
                data: typedArrayToBase64(value),
            };
        }
        return value;
    });
}

/**
 * Deserialize a snapshot from a JSON string, converting base64 back to TypedArrays.
 * @param {string} json
 * @returns {object} snapshot object
 */
export function snapshotFromJSON(json) {
    return JSON.parse(json, (key, value) => {
        if (value && value.__typedArray) {
            const Constructor = TypedArrayConstructors[value.type];
            if (!Constructor) {
                throw new Error(`Unknown TypedArray type: ${value.type}`);
            }
            return base64ToTypedArray(value.data, Constructor);
        }
        return value;
    });
}
