const {requirejs} = require('./r');
const assert = require('assert');
const {describe, it} = require('mocha');

const utils = requirejs('utils');
const fs = require('fs');

function testOneFile(file) {
    "use strict";
    return done => {
        const compressed = new Uint8Array(fs.readFileSync(file + ".gz"));
        const expected = new Uint8Array(fs.readFileSync(file));
        assert.deepStrictEqual(utils.ungzip(compressed), expected);
        done();
    };
}

describe('gzip tests', function () {
    "use strict";
    for (let fileIndex = 1; ; fileIndex++) {
        let file = __dirname + "/gzip/test-" + fileIndex;
        if (!fs.existsSync(file)) break;
        it('handles test case ' + file, testOneFile(file));
    }
});
