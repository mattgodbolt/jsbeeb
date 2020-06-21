(function () {
    "use strict";

    function getBasePath() {
        if (typeof window === "undefined") return "/";
        var path = window.location.pathname;
        var lastSlash = path.lastIndexOf(path);
        if (lastSlash !== -1) path = path.substr(0, lastSlash);
        return path;
    }

    /* globals requirejs */
    requirejs.config({
        baseUrl: getBasePath(),
        paths: {
            'async': 'lib/requirejs-async',
            'jquery': 'lib/jquery.min',
            'jquery-visibility': 'lib/jquery-visibility',
            'bootstrap': 'lib/bootstrap.min',
            'gapi': 'lib/gapi',
            'jsunzip': 'lib/jsunzip',
            'promise': 'lib/promise-6.0.0',
            'underscore': 'lib/underscore-min',
            'webgl-debug': 'lib/webgl-debug'
        },
        shim: {
            'underscore': {exports: '_'},
            'bootstrap': ['jquery'],
            'jquery-visibility': ['jquery']
        }
    });
})();