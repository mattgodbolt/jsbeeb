var requirejs = require('requirejs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['video', '6502', 'soundchip', 'fdc', 'utils'],
    function (Video, Cpu6502, SoundChip, disc, utils) {
        utils.bench();
    }
);
