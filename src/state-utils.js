"use strict";

/**
 * Convert a TypedArray to a base64 string for JSON serialization.
 * @param {ArrayBufferView} typedArray
 * @returns {string} base64-encoded string
 */
export function typedArrayToBase64(typedArray) {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert a base64 string back to a TypedArray.
 * @param {string} base64 base64-encoded string
 * @param {function} TypedArrayConstructor constructor for the desired type (e.g., Uint8Array)
 * @returns {ArrayBufferView} the decoded typed array
 */
export function base64ToTypedArray(base64, TypedArrayConstructor) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    // Create a properly aligned typed array from the raw bytes
    const elementSize = TypedArrayConstructor.BYTES_PER_ELEMENT;
    const length = bytes.length / elementSize;
    if (!Number.isInteger(length)) {
        throw new Error(
            `Base64 data length (${bytes.length} bytes) is not a multiple of ${TypedArrayConstructor.name} element size (${elementSize})`,
        );
    }
    const result = new TypedArrayConstructor(length);
    new Uint8Array(result.buffer).set(bytes);
    return result;
}

/**
 * Deep copy a snapshot object, cloning any TypedArrays found within.
 * This ensures rewind buffer snapshots are fully isolated from live state.
 * @param {object} obj snapshot object to copy
 * @returns {object} a deep copy with all TypedArrays cloned
 */
export function deepCopySnapshot(obj) {
    if (obj === null || typeof obj !== "object") {
        return obj;
    }
    if (ArrayBuffer.isView(obj)) {
        return obj.slice();
    }
    if (Array.isArray(obj)) {
        return obj.map((item) => deepCopySnapshot(item));
    }
    const copy = {};
    for (const key of Object.keys(obj)) {
        copy[key] = deepCopySnapshot(obj[key]);
    }
    return copy;
}
