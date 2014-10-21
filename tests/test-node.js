var requirejs = require('requirejs');

requirejs.config({
    baseUrl: ".",
    paths: {
        'jsunzip': 'lib/jsunzip',
        'underscore': 'lib/underscore-min',
        'test': 'tests/test'
    }
});

requirejs(['tests/test'], function (test) {
    "use strict";
    function log() {
        console.log.apply(console, arguments);
    }

    function beginTest(name) {
        console.log("Starting", name);
    }

    function endTest(name, failures) {
        console.log("Ending", name, failures ? " - failed" : " - success");
    }

    var paint = function () {
    };
    var fb32 = new Uint32Array(1280 * 1024);
    test.run(log, beginTest, endTest, function (fails) {
        if (fails) process.exit(1);
    }, fb32, paint);
});
