"use strict";

/**
 * Circular buffer of emulator state snapshots for rewind functionality.
 * Snapshots are stored directly without deep-copying, since
 * snapshotState() already clones all TypedArrays via .slice().
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
     * Push a snapshot into the buffer.
     * The caller must ensure the snapshot's typed arrays are already
     * independent copies (e.g. from snapshotState() which uses .slice()).
     * Overwrites the oldest snapshot when full.
     * @param {object} snapshot - emulator state snapshot (already cloned)
     */
    push(snapshot) {
        this.snapshots[this.writeIndex] = snapshot;
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
