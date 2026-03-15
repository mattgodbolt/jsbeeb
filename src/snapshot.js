"use strict";

import { typedArrayToBase64, base64ToTypedArray } from "./state-utils.js";
import { findModel } from "./models.js";

const SnapshotFormat = "jsbeeb-snapshot";
const SnapshotVersion = 1;

/**
 * Check if two model names are compatible for state restore.
 * Resolves synonyms via findModel and compares base machine type,
 * ignoring filesystem variant differences (DFS vs ADFS etc).
 */
export function modelsCompatible(snapshotModel, currentModel) {
    if (snapshotModel === currentModel) return true;
    const resolvedSnapshot = findModel(snapshotModel);
    const resolvedCurrent = findModel(currentModel);
    if (resolvedSnapshot && resolvedCurrent) {
        // Same model object, or same base machine (strip filesystem suffix)
        if (resolvedSnapshot === resolvedCurrent) return true;
        const base = (name) => name.replace(/\s*\(.*\)$/, "");
        return base(resolvedSnapshot.name) === base(resolvedCurrent.name);
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
 * Create a snapshot of the emulator state.
 * @param {import('./6502.js').Cpu6502} cpu
 * @param {object} model - the model definition object
 * @returns {object} snapshot object
 */
export function createSnapshot(cpu, model) {
    return {
        format: SnapshotFormat,
        version: SnapshotVersion,
        model: model.name,
        timestamp: new Date().toISOString(),
        state: cpu.snapshotState(),
    };
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
