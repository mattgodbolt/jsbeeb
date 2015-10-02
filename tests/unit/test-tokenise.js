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

function dehex(x) { return x; }

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

/* TODO: fix
exports.testOneLineTetris = function(test) {
    check(test, 
            "d=d:IFdVDUd:a=POINT(32*POS,31-VPOS<<5):RETURNELSEMODE9:" +
            "GCOL-9:CLG:OFF:d=9:REPEATVDU30:REPEATGOSUBFALSE:IFPOS=28VDUPOS,15,VPOS,24;11,26:" +
            "IF0ELSEIFa=0PRINT:UNTIL0ELSEUNTILVPOS=25:v=ABSRNDMOD7:i=0:VDU4895;3:" +
            "REPEATm=9-INKEY6MOD3:FORr=TRUETO1:t=rANDSGNt:IFt=rCOLOURv-15:VDUrEORm:" +
            "i+=m=7AND9-6*r:IF0ELSEFORn=0TO11:d=n/3OR2EORd:GOSUBFALSE:" +
            "IF1<<(n+i)MOD12AND975AND&C2590EC/8^vVDU2080*ABSr;:t+=a:" + 
            "IF0ELSENEXT,:VDU20:UNTILt*LOGm:UNTILVPOS=3",
            dehex("0D00002D643D643AE76420EF643A703DB036342AB12C3145332DBC2A3332293AF8208BEB323AE6302C2D393ADA0D000138643D393AF5EF33303AF5E4A33AE7B13D3135EF32382 C352CBC2C31343B31312C32363AE7308BE7703D30F13AFD308BFDBC3D32350D000217623D94B32083373A6B3D303AEF33312C392C330D00030DF5673D392DA63683330D000413E36C3DB920B8313A6F3D6C2080B46F0D000524E76F3D6C20FB622D31353AEF6C2082673A6B3D6B2B28673D3780392D362A6C290D00061BE7308BE3663D30B831313A643D662F33843282643AE4A30D000738E7325E2828662B6B2983313229803937358026433235393045432F385E6220EF323038302A946C3B3A6F3D6F2B703AE7308BED2C0D000810EF32303AFD6F2AAB673AFD300DFF"));
};*/

exports.testStringsWithTokens = function(test) {
    check(test, "PRINT \"IF \"\"IF\"\" IF\"", "\r\x00\x0a\x14\xf1 \"IF \"\"IF\"\" IF\"\r\xff");
};
