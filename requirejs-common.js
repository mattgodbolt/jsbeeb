requirejs.config({
    baseUrl: window.location.pathname,
    paths: {
        'jquery': 'lib/jquery.min',
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
