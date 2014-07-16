var requirejs = require('requirejs');
var Png = require('png').Png;
var fs = require('fs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['video', '6502', 'soundchip', 'fdc', 'utils'],
    function (Video, Cpu6502, SoundChip, disc, utils) {
        for (var j = 0; j < 10; ++j) {
            var res = 0;
            var start = Date.now();
            for (var i = 0; i < 4096 * 1024; ++i) {
                res += utils.signExtend(i & 0xff);
            }
            var tt = Date.now() - start;
            console.log(res, tt);
        }
    }
)
;
