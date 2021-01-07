const {requirejs} = require('./r');
const {describe, it} = require('mocha');
const assert = require('assert');
const tokeniser = requirejs('basic-tokenise').create();

describe('Tokeniser', function () {
    "use strict";

    function check(done, text, expected) {
        tokeniser.then(function (t) {
            assert.strictEqual(t.tokenise(text), expected);
            done();
        }).catch(function (e) {
            console.log("Failed:", e);
            assert.strictEqual(e, "");
            done();
        });
    }

    function checkThrows(done, text, expectedError) {
        tokeniser.then(function (t) {
            t.tokenise(text);
            console.log("Failed to give exeception with message:", expectedError);
            assert.strictEqual(false, true);
            done();
        }).catch(function (e) {
            assert.strictEqual(e.message, expectedError);
            done();
        });
    }

    it('handles a simple program', function (done) {
        check(done, "10 PRINT \"hello\"\n20 GOTO 10\n",
            "\r\x00\x0a\x0e \xf1 \"hello\"\r\x00\x14\x0b \xe5 \x8d\x54\x4a\x40\r\xff");
    });
    it('handles assignment to HIMEM', function (done) {
        check(done, "HIMEM=&6000", "\r\x00\x0a\x0b\xd3=&6000\r\xff");
    });
    it('handles reading from HIMEM', function (done) {
        check(done, "PRINT HIMEM", "\r\x00\x0a\x07\xf1 \x93\r\xff");
    });
    it('deals with colons', function (done) {
        check(done, "PRINT HIMEM:HIMEM=&6000", "\r\x00\x0a\x0f\xf1 \x93:\xd3=&6000\r\xff");
    });
    it('handles MODE', function (done) {
        check(done, "IF0ELSEMODE0", "\r\x00\x0a\x09\xe70\x8b\xeb0\r\xff");
    });
    it('handles a snippet from one line Tetris', function (done) {
        check(done, "d=d:IFd VDUd:p=POINT(64*POS,1E3-VPOS*32):RETURN ELSEMODE2:GCOL0,-9:CLG",
            "\r\x00\x0a\x2dd=d:\xe7d \xefd:p=\xb064*\xb1,1E3-\xbc*32):\xf8 \x8b\xeb2:\xe60,-9:\xda\r\xff");
    });
    it('copes with token names inside strings', function (done) {
        check(done, "PRINT \"IF \"\"IF\"\" IF\"", "\r\x00\x0a\x14\xf1 \"IF \"\"IF\"\" IF\"\r\xff");
    });
    it('handles REM', function (done) {
        check(done, "10REM I am a monkey", "\r\x00\x0a\x13\xf4 I am a monkey\r\xff");
    });
    it('handles extra long input', function (done) {
        check(done, "10" + "ENVELOPE".repeat(251), "\r\x00\x0a\xff" + "\xe2".repeat(251) + "\r\xff");
    });
    it('gives error for overlong input', function (done) {
        checkThrows(done, "10" + "ENVELOPE".repeat(252), 'Line 10 tokenised length 252 > 251 bytes');
    });
});
