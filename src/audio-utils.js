"use strict";

/**
 * Create an AudioContext with a fallback for older WebKit browsers.
 * @param {AudioContextOptions} [options] - passed to the AudioContext constructor
 * @returns {AudioContext|null}
 */
export function createAudioContext(options) {
    /*global webkitAudioContext*/
    if (typeof AudioContext !== "undefined") return new AudioContext(options);
    if (typeof webkitAudioContext !== "undefined") return new webkitAudioContext(options);
    return null;
}
