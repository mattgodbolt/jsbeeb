// Reading window.localStorage itself throws (or, in some browsers, gives null) when the browser refuses the page
// storage. The stand-in is made afresh each time, so what is written to it is gone at once.
const nothingKept = () => ({ length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} });

function reachable(name) {
    try {
        return window[name] ?? nothingKept();
    } catch {
        return nothingKept();
    }
}

/** @returns {Storage} the browser's local storage, or one holding nothing and keeping nothing if it is refused. */
export const localStore = () => reachable("localStorage");

/** @returns {Storage} the browser's session storage, or one holding nothing and keeping nothing if it is refused. */
export const sessionStore = () => reachable("sessionStorage");
