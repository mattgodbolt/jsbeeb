// To be run directly from 'js' or 'd8'. Exercises just the video code in as representative
// a way as I can easily achieve.

///////////////////////////////////////////////////
// Enough of the code assumes there's a console.log that I've just made one here
var console = {
    log: function () {
        print.apply(console, arguments);
    }
};
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// Gook to simulate enough of requirejs to get Video to load
load('./lib/require.js');
requirejs.load = function (context, moduleName, url) {
    "use strict";
    load(url);
    context.completeLoad(moduleName);
};
requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min'
    }
});

fs = {};
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// Set up of the video object and its fake callbacks.
requirejs(['video'], function (Video) {
    "use strict";
    var fb32 = new Uint32Array(1280 * 1024);
    var frame = 0;

    function paint() {
        frame++;
    }

    var video = new Video(fb32, paint);
    var fakeCpu = {
        videoRead: function (addr) {
            return addr & 0xff; // Proxy for having real data
        }
    };
    var noop = function () {
    };
    var fakeVia = {
        setVBlankInt: noop
    };
    video.reset(fakeCpu, fakeVia);
    ///////////////////////////////////////////////////

    function benchmark(frames) {
        "use strict";
        print("Benchmarking over " + frames + " frames...");
        // Profiles N frames, a few cycles at a time (like the CPU would do).
        frame = 0;
        var start = Date.now();
        while (frame < frames) {
            video.polltime(6);
        }
        var end = Date.now();
        var taken = end - start;
        print("Took " + taken + "ms to run " + frames + " frames, " + (taken / frames) + "ms/frame");
    }

    ///////////////////////////////////////////////////
    // Set up registers for MODE 2
    var MODE2_REGS = [127, 80, 98, 40, 38, 0, 32, 35, 1, 7, 103, 8, 6, 0, 6, 4];
    MODE2_REGS.forEach(function (val, reg) {
        video.crtc.write(0, reg);
        video.crtc.write(1, val);
    });
    var MODE2_PALETTE = [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8];
    MODE2_PALETTE.forEach(function (val, reg) {
        video.ula.write(0, (reg << 4) | val);
    });
    video.ula.write(1, 0xf5);
    ///////////////////////////////////////////////////

    ///////////////////////////////////////////////////
    // Run it for a couple of emulated seconds, to warm it up
    video.polltime(2 * 2 * 1000000);

    // And now benchmark for a large number of frames
    benchmark(5000);
});
