const {requirejs} = require('./r');
const assert = require('assert');

var utils = requirejs('utils');
var fs = require('fs');

describe('gzip tests', function () {
    for (var fileIndex = 1; ; fileIndex++) {
        let file = __dirname + "/gzip/test-" + fileIndex;
        if (!fs.existsSync(file)) break;
        it('handles test case ' + file, function (done) {
            var compressed = new Uint8Array(fs.readFileSync(file + ".gz"));
            var expected = new Uint8Array(fs.readFileSync(file));
            assert.deepEqual(utils.ungzip(compressed), expected);
            done();
        });
    }
});
