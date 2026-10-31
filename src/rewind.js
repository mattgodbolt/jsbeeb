/**
 * Circular buffer of emulator state snapshots, for rewind and the frame ring that feeds it.
 * Snapshots are stored directly, so the caller hands over ones nothing else holds.
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
     * Push a snapshot into the buffer, overwriting the oldest when full.
     * @param {object} snapshot - emulator state snapshot that nothing else holds
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
     * The snapshot the next push overwrites, whose storage that push may reuse.
     * @returns {object|null} the oldest snapshot when full, or null
     */
    nextToReplace() {
        return this.count === this.maxSnapshots ? this.snapshots[this.writeIndex] : null;
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
     * Return all snapshots in order from oldest to newest.
     * @returns {object[]} array of snapshots
     */
    getAll() {
        const result = new Array(this.count);
        const start = (this.writeIndex - this.count + this.maxSnapshots) % this.maxSnapshots;
        for (let i = 0; i < this.count; i++) {
            result[i] = this.snapshots[(start + i) % this.maxSnapshots];
        }
        return result;
    }

    /**
     * Number of snapshots currently stored.
     * @returns {number}
     */
    get length() {
        return this.count;
    }
}
