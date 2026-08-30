import * as utils from "../utils.js";
import { toast } from "./toast.js";

export const errorText = (error) => error?.message ?? `${error}`;

export function reportLoadFailure(description, error) {
    console.error(`Error loading ${description}:`, error);
    toast(`Could not load ${description}: ${errorText(error)}`, { title: "Loading" });
}

export function reportIgnoredFiles(name, ignored) {
    if (!ignored.length) return;
    toast(`Loaded ${name}. The archive also holds ${ignored.join(", ")}, and only one file is loaded from it.`, {
        title: "Archive",
    });
}

export async function unzipAndReport(data) {
    const unzipped = await utils.unzipDiscImage(data);
    reportIgnoredFiles(unzipped.name, unzipped.ignored);
    return unzipped;
}

/** Handles a component's "notice" event by toasting it. */
export function showNotice(event) {
    const { message, title, quietKey } = event.detail;
    toast(message, { title, quietKey });
}
