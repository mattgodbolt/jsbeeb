// Reading window.localStorage itself throws when the browser refuses the page storage. The stand-in is made afresh
// each time, so what is written to it is gone at once.
function reachable(name) {
    try {
        return window[name];
    } catch {
        return { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} };
    }
}

/** @returns {Storage} the browser's local storage, or one holding nothing and keeping nothing if it is refused. */
export const localStore = () => reachable("localStorage");

/** @returns {Storage} the browser's session storage, or one holding nothing and keeping nothing if it is refused. */
export const sessionStore = () => reachable("sessionStorage");
