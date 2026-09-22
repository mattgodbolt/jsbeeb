const NoStartupActions = {
    autoboot: undefined,
    autochain: undefined,
    autorun: undefined,
    autotype: undefined,
    loadBasic: undefined,
    embedBasic: undefined,
    patch: undefined,
};

/**
 * Reloads the page as the machine `params` name (`model`, `coProcessor`), the rest of the URL as
 * `params` say and the page's own startup actions dropped. `replace` leaves no history entry.
 */
export function reloadAsMachine(urlState, params, { replace = false } = {}) {
    const url = urlState.urlWith({ ...NoStartupActions, ...params });
    if (replace) window.location.replace(url);
    else window.location.href = url;
}

/** Leaves `value` under `key` for the page a reload brings up. */
export function leaveForNextPage(key, value) {
    sessionStorage.setItem(key, value);
}

/** Takes what the last page left under `key`, once; null when it left nothing. */
export function takeFromLastPage(key) {
    const value = sessionStorage.getItem(key);
    if (value !== null) sessionStorage.removeItem(key);
    return value;
}
