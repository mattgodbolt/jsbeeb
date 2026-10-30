/**
 * The value kept as JSON under `key`, or null when there is none, there is no storage, or it cannot be read; a failure
 * is logged as reading `what`.
 * @param {(() => Storage) | null} storage
 * @param {string} key
 * @param {string} what
 */
export function readStored(storage, key, what) {
    if (!storage) return null;
    try {
        return JSON.parse(storage().getItem(key) ?? "null");
    } catch (error) {
        console.warn(`Could not read ${what}: ${error}`);
        return null;
    }
}

/**
 * Keeps `value` as JSON under `key`, if there is storage; a failure, such as a full or blocked storage, is logged as
 * saving `what`.
 * @param {(() => Storage) | null} storage
 * @param {string} key
 * @param {*} value
 * @param {string} what
 */
export function writeStored(storage, key, value, what) {
    if (!storage) return;
    try {
        storage().setItem(key, JSON.stringify(value));
    } catch (error) {
        console.warn(`Could not save ${what}: ${error}`);
    }
}
