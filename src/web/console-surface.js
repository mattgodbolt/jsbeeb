"use strict";

import * as utils from "./../utils.js";

/**
 * The debugging surface the wiki documents, put on `target` (window in the
 * app). The bench/profile calls are debounced so that they can be safely run
 * from the JS console in firefox.
 */
export function exposeConsoleSurface(target, { loop, processor, video, audioHandler }) {
    target.benchmarkCpu = utils.debounce((numCycles) => loop.benchmarkCpu(numCycles), 1);
    target.profileCpu = utils.debounce((arg) => loop.profileCpu(arg), 1);
    target.benchmarkVideo = utils.debounce((numCycles) => loop.benchmarkVideo(numCycles), 1);
    target.profileVideo = utils.debounce((arg) => loop.profileVideo(arg), 1);
    target.go = () => loop.go();
    target.stop = (debug) => loop.stop(debug);
    target.soundChip = audioHandler.soundChip;
    target.processor = processor;
    target.video = video;
    target.hd = (start, end) => {
        console.log(utils.hd((x) => processor.readmem(x), start, end));
    };
    target.m7dump = () => {
        console.log(utils.hd((x) => processor.readmem(x) & 0x7f, 0x7c00, 0x7fe8, { width: 40, gap: false }));
    };
}
