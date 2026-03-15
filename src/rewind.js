"use strict";

import { deepCopySnapshot } from "./state-utils.js";

/**
 * Circular buffer of emulator state snapshots for rewind functionality.
 * Snapshots are deep-copied on push to ensure isolation from live state.
 */
export class RewindBuffer {
    /**
     * @param {number} maxSnapshots - maximum number of snapshots to retain
     */
    constructor(maxSnapshots = 30) {
        this.maxSnapshots = maxSnapshots;
        this.snapshots = new Array(maxSnapshots);
        this.count = 0;
        this.writeIndex = 0;
    }

    /**
     * Push a snapshot into the buffer, deep-copying all typed arrays.
     * Overwrites the oldest snapshot when full.
     * @param {object} snapshot - emulator state snapshot
     */
    push(snapshot) {
        this.snapshots[this.writeIndex] = deepCopySnapshot(snapshot);
        this.writeIndex = (this.writeIndex + 1) % this.maxSnapshots;
        if (this.count < this.maxSnapshots) this.count++;
    }

    /**
     * Pop the most recent snapshot from the buffer.
     * @returns {object|null} the most recent snapshot, or null if empty
     */
    pop() {
        if (this.count === 0) return null;
        this.writeIndex = (this.writeIndex - 1 + this.maxSnapshots) % this.maxSnapshots;
        this.count--;
        const snapshot = this.snapshots[this.writeIndex];
        this.snapshots[this.writeIndex] = null;
        return snapshot;
    }

    /**
     * Peek at the most recent snapshot without removing it.
     * @returns {object|null} the most recent snapshot, or null if empty
     */
    peek() {
        if (this.count === 0) return null;
        const index = (this.writeIndex - 1 + this.maxSnapshots) % this.maxSnapshots;
        return this.snapshots[index];
    }

    /**
     * Clear all snapshots from the buffer.
     */
    clear() {
        this.snapshots.fill(null);
        this.count = 0;
        this.writeIndex = 0;
    }

    /**
     * Number of snapshots currently stored.
     * @returns {number}
     */
    get length() {
        return this.count;
    }
}
