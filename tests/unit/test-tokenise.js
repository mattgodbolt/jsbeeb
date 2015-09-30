var requirejs = require('requirejs');
var t = requirejs('basic-tokenise');

exports.testSimpleProgram = function (test) {
    var tokens = t.tokenise("10 PRINT \"hello\"\n20 GOTO 10\n");
    var expected = "\r\x00\x0a\x0e \xf1 \"hello\"\r\x00\x14\x0b \xe5 \x8d\x54\x4a\x40\r\xff";
    test.equals(tokens, expected);
    test.done();
};

exports.testAssignHimem = function(test) {
    var tokens = t.tokenise("HIMEM=&6000");
    test.equals(tokens, "\r\x00\x0a\x0b\xd3=&6000\r\xff");
    test.done();
};

exports.testReadHimem = function(test) {
    var tokens = t.tokenise("PRINT HIMEM");
    test.equals(tokens, "\r\x00\x0a\x07\xf1 \x93\r\xff");
    test.done();
};

exports.testColon = function(test) {
    var tokens = t.tokenise("PRINT HIMEM:HIMEM=&6000");
    test.equals(tokens, "\r\x00\x0a\x0f\xf1 \x93:\xd3=&6000\r\xff");
    test.done();
};

exports.testMode = function(test) {
    var tokens = t.tokenise("IF0ELSEMODE0");
    test.equals(tokens, "\r\x00\x0a\x09\xe70\x8b\xeb0\r\xff");
    test.done();
};

exports.testOneLineTetris = function(test) {
    var tokens = t.tokenise("d=d:IFd VDUd:p=POINT(64*POS,1E3-VPOS*32):RETURN ELSEMODE2:GCOL0,-9:CLG");
    test.equals(tokens, "\r\x00\x0a\x2dd=d:\xe7d \xefd:p=\xb064*\xb1,1E3-\xbc*32):\xf8 \x8b\xeb2:\xe60,-9:\xda\r\xff");
    test.done();
};

exports.testStringsWithTokens = function(test) {
    var tokens = t.tokenise("PRINT \"IF \"\"IF\"\" IF\"");
    test.equals(tokens, "\r\x00\x0a\x14\xf1 \"IF \"\"IF\"\" IF\"\r\xff");
    test.done();
};
