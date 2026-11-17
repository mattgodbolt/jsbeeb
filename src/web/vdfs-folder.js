// The folder the user chose to serve as VDFS in a browser: kept in IndexedDB, which can hold a folder handle, so the
// next page can use it. See docs/vdfs.md.

import { FolderStore } from "./vdfs-folder-store.js";

const DatabaseName = "jsbeeb-vdfs";
const StoreName = "folders";
const FolderKey = "folder";

export const canChooseFolder = () => typeof window.showDirectoryPicker === "function";

function inDatabase(mode, work) {
    return new Promise((resolve, reject) => {
        const opening = indexedDB.open(DatabaseName, 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore(StoreName);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const database = opening.result;
            const transaction = database.transaction(StoreName, mode);
            const request = work(transaction.objectStore(StoreName));
            transaction.oncomplete = () => {
                database.close();
                resolve(request.result);
            };
            transaction.onerror = transaction.onabort = () => {
                database.close();
                reject(transaction.error);
            };
        };
    });
}

export const savedFolder = () =>
    inDatabase("readonly", (store) => store.get(FolderKey)).then((handle) => handle ?? null);
export const saveFolder = (handle) => inDatabase("readwrite", (store) => store.put(handle, FolderKey));
export const forgetFolder = () => inDatabase("readwrite", (store) => store.delete(FolderKey));

/** Asks the user for a folder, which needs a click, and keeps it for the next page. */
export async function chooseFolder() {
    const handle = await window.showDirectoryPicker({ id: "vdfs", mode: "readwrite" });
    await saveFolder(handle);
    return handle;
}

/** @returns {FolderStore | null} the store of the folder the page was asked to serve, in a browser that can */
export function browserVdfsStore(query) {
    return query.vdfs && canChooseFolder() ? new FolderStore(() => savedFolder().catch(() => null)) : null;
}
