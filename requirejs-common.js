(function () {
    function getBasePath() {
        if (typeof window === "undefined") return "/";
        var path = window.location.pathname;
        var lastSlash = path.lastIndexOf(path);
        if (lastSlash !== -1) path = path.substr(0, lastSlash);
        return path;
    }

    requirejs.config({
        baseUrl: getBasePath(),
        paths: {
            'jquery': 'lib/jquery.min',
            'jquery-visibility': 'lib/jquery-visibility',
            'bootstrap': 'lib/bootstrap.min',
            'dropbox': 'lib/dropbox.min',
            'jsunzip': 'lib/jsunzip',
            'underscore': 'lib/underscore-min'
        },
        shim: {
            'underscore': { exports: '_' },
            'bootstrap': [ 'jquery' ]
        }
    });
})();