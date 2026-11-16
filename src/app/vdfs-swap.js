/**
 * Changes the folder served as VDFS in the order that keeps what the old page wrote out of the new folder: the page
 * hands over what it has and stops persisting, the writes that are in flight finish, and only then is the folder
 * changed and the page started again.
 */
export async function swapVdfsFolder({ flushPage, inFlight, changeFolder, loadPage }) {
    await flushPage();
    await Promise.allSettled([...inFlight()]);
    changeFolder();
    await loadPage();
}
