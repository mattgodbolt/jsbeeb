// Fake out enough of requirejs to get it to work
const requirejs = require('requirejs');

requirejs.config({
    baseUrl: __dirname + "/../..",
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min',
        'test': 'tests/test'
    }
});

exports.requirejs = requirejs;