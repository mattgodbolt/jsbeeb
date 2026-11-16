/**
 * Waits for the pages to hand over what the BBC wrote and stop persisting, and for the writes in flight to finish, so
 * that nothing the old pages wrote can reach, or be lost to, the folder that comes next.
 */
export async function drainVdfs({ flushPages, inFlight }) {
    await Promise.all(flushPages());
    await Promise.allSettled([...inFlight()]);
}

/** Changes the folder served as VDFS, and starts the page again with it, once the old pages are drained. */
export async function swapVdfsFolder({ flushPages, inFlight, changeFolder, loadPage }) {
    await drainVdfs({ flushPages, inFlight });
    changeFolder();
    await loadPage();
}
