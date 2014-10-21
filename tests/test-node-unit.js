var requirejs = require('requirejs');

requirejs.config({
    baseUrl: ".",
    paths: {
        'jsunzip': 'lib/jsunzip',
        'underscore': 'lib/underscore-min',
        'test': 'tests/test'
    }
});

requirejs(['nodeunit'], function (nodeunit) {
    "use strict";

    var reporter = nodeunit.reporters.default;
    reporter.run(['tests/unit'], undefined, function (err) {
        if (err) process.exit(1);
    });
});
