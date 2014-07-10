var requirejs = require('requirejs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['video', '6502', 'soundchip'],
    function (Video, Cpu6502, SoundChip) {
        var fb32 = new Uint32Array(1024 * 768);
        var video = new Video(fb32, function () {
            console.log("paint");
        });
        var dbgr = {};
        var soundChip = new SoundChip(10000);
        soundChip.toneGenerator = {
            mute: function () {
            },
            tone: function () {
            }
        };
        var cpu = new Cpu6502(dbgr, video, soundChip);
    });
//
//requirejs.config({
//    //Pass the top-level main.js/index.js require
//    //function to requirejs so that node modules
//    //are loaded relative to the top-level JS file.
//    nodeRequire: require
//});
//
