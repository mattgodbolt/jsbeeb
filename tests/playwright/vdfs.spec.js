// A folder served as VDFS in a browser, end to end: the saved folder handle, the permission, the store and the ROM. The
// folder is the origin-private filesystem's, which is a real directory handle that the picker is not needed for.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test as base } from "./fixtures.js";

// Chrome stops the whole browser if a folder handle is stored in IndexedDB in the throwaway profile a test gets
// by default, so these tests run in a profile that lasts for the test, as a person's does.
const test = base.extend({
    context: async ({ playwright, browserName, launchOptions, channel, baseURL, viewport }, use) => {
        const profile = await mkdtemp(path.join(tmpdir(), "jsbeeb-vdfs-e2e-"));
        const context = await playwright[browserName].launchPersistentContext(profile, {
            ...launchOptions,
            channel,
            baseURL,
            viewport,
        });
        await use(context);
        await context.close();
        await rm(profile, { recursive: true, force: true });
    },
});

const SavedFolder = { database: "jsbeeb-vdfs", store: "folders", key: "folder" };

/** Puts a folder with `files` where the page keeps the one the user chose, as the picker and the menu would. */
async function chooseFolderWith(page, files) {
    await page.evaluate(
        async ({ saved, files }) => {
            const opfs = await navigator.storage.getDirectory();
            await opfs.removeEntry("vdfs-e2e", { recursive: true }).catch(() => {});
            const folder = await opfs.getDirectoryHandle("vdfs-e2e", { create: true });
            for (const [name, text] of Object.entries(files)) {
                const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
                await writable.write(text);
                await writable.close();
            }
            const database = await new Promise((resolve, reject) => {
                const opening = indexedDB.open(saved.database, 1);
                opening.onupgradeneeded = () => opening.result.createObjectStore(saved.store);
                opening.onsuccess = () => resolve(opening.result);
                opening.onerror = () => reject(opening.error);
            });
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(saved.store, "readwrite");
                transaction.objectStore(saved.store).put(folder, saved.key);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
            });
            database.close();
        },
        { saved: SavedFolder, files },
    );
}

const folderText = (page, name) =>
    page.evaluate(async (file) => {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("vdfs-e2e");
        const handle = await folder.getFileHandle(file).catch(() => null);
        return handle ? (await handle.getFile()).text() : null;
    }, name);

test.describe("VDFS from a folder in the browser", () => {
    test("lists the folder, and saves into it", async ({ beeb, page }) => {
        await beeb.open();
        await chooseFolderWith(page, { HELLO: "hi", "HELLO.inf": "$.HELLO  FFFF2000 FFFF2000 00000002\n" });

        await beeb.open(`?vdfs=1&autotype=${encodeURIComponent("*VDFS\n*CAT\n*SAVE OUT 2000 2004\n")}`);
        await beeb.expectScreenText("HELLO");
        await expect.poll(() => folderText(page, "OUT.inf")).toContain("2000");
    });

    test("offers to serve a folder, and to stop once one is served", async ({ beeb, page }) => {
        await beeb.open();
        await page.click("#navbarMore");
        await expect(page.locator("#vdfs-serve")).toBeVisible();
        await expect(page.locator("#vdfs-stop")).toBeHidden();

        await chooseFolderWith(page, { HELLO: "hi" });
        await beeb.open("?vdfs=1");
        await page.click("#navbarMore");
        await expect(page.locator("#vdfs-stop")).toBeVisible();
    });
});
