/** Waits for outstanding work before quitting, but leaves a reactivated app running. */
export function quitAfterLastWindowCloses({ pendingOperations, getWindowCount, quit }) {
    return Promise.allSettled([...pendingOperations]).then(() => {
        if (getWindowCount() === 0) quit();
    });
}
