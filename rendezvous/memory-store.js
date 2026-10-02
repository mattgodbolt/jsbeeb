/**
 * @typedef {{room: string, entry: string, expires: number} & Record<string, unknown>} RendezvousItem
 *
 * @typedef {object} RendezvousStore
 * @property {(room: string, entry: string) => Promise<RendezvousItem | undefined>} get
 * @property {(item: RendezvousItem, options?: {unlessLiveAt?: number}) => Promise<boolean>} put writes the
 *     item, or with `unlessLiveAt` writes it only if no item with that key expires after that time, and
 *     says whether it wrote
 * @property {(room: string) => Promise<RendezvousItem[]>} query every item in the room, expired or not
 * @property {(room: string, entry: string) => Promise<void>} delete
 */

/**
 * Keeps items until they are deleted, as DynamoDB's TTL may, so expiry is the handler's to check.
 *
 * @returns {RendezvousStore}
 */
export function createMemoryStore() {
    const rooms = new Map();
    const roomOf = (room) => {
        if (!rooms.has(room)) rooms.set(room, new Map());
        return rooms.get(room);
    };
    return {
        async get(room, entry) {
            const item = rooms.get(room)?.get(entry);
            return item && structuredClone(item);
        },
        async put(item, { unlessLiveAt } = {}) {
            const existing = rooms.get(item.room)?.get(item.entry);
            if (unlessLiveAt !== undefined && existing && existing.expires > unlessLiveAt) return false;
            roomOf(item.room).set(item.entry, structuredClone(item));
            return true;
        },
        async query(room) {
            return [...(rooms.get(room)?.values() ?? [])].map((item) => structuredClone(item));
        },
        async delete(room, entry) {
            const items = rooms.get(room);
            items?.delete(entry);
            if (items?.size === 0) rooms.delete(room);
        },
    };
}
