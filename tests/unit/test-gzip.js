var requirejs = require('requirejs');
var utils = requirejs('utils');
var fs = require('fs');

for (var fileIndex = 1; ; fileIndex++) {
    var file = "tests/unit/gzip/test-" + fileIndex;
    if (!fs.existsSync(file)) return;
    (function (file) {
        exports["regress.test" + fileIndex] = function (test) {
            var compressed = new Uint8Array(fs.readFileSync(file + ".gz"));
            var expected = new Uint8Array(fs.readFileSync(file));
            test.same(utils.ungzip(compressed), expected);
            test.done();
        };
    })(file);
}
