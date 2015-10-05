var requirejs = require('requirejs');
var tokeniser = requirejs('basic-tokenise').create();

function check(test, text, expected) {
    "use strict";
    tokeniser.then(function(t){
        var tokens = t.tokenise(text);
        test.equals(tokens, expected);
        test.done();
    }).catch(function(e){
        console.log("Failed:", e);
        test.equals(e, "");
        test.done();
    });
}

exports.testSimpleProgram = function (test) {
    check(test, "10 PRINT \"hello\"\n20 GOTO 10\n",
        "\r\x00\x0a\x0e \xf1 \"hello\"\r\x00\x14\x0b \xe5 \x8d\x54\x4a\x40\r\xff");
};

exports.testAssignHimem = function(test) {
    check(test, "HIMEM=&6000", "\r\x00\x0a\x0b\xd3=&6000\r\xff");
};

exports.testReadHimem = function(test) {
    check(test, "PRINT HIMEM", "\r\x00\x0a\x07\xf1 \x93\r\xff");
};

exports.testColon = function(test) {
    check(test, "PRINT HIMEM:HIMEM=&6000", "\r\x00\x0a\x0f\xf1 \x93:\xd3=&6000\r\xff");
};

exports.testMode = function(test) {
    check(test, "IF0ELSEMODE0", "\r\x00\x0a\x09\xe70\x8b\xeb0\r\xff");
};

exports.testOneLineTetris = function(test) {
    check(test, "d=d:IFd VDUd:p=POINT(64*POS,1E3-VPOS*32):RETURN ELSEMODE2:GCOL0,-9:CLG",
        "\r\x00\x0a\x2dd=d:\xe7d \xefd:p=\xb064*\xb1,1E3-\xbc*32):\xf8 \x8b\xeb2:\xe60,-9:\xda\r\xff");
};

exports.testStringsWithTokens = function(test) {
    check(test, "PRINT \"IF \"\"IF\"\" IF\"", "\r\x00\x0a\x14\xf1 \"IF \"\"IF\"\" IF\"\r\xff");
};
