var requirejs = require('requirejs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['utils'],
    function (utils) {
        utils.bench();
    }
);
