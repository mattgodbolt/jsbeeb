"use strict";
import * as test from "./test.js";

function log() {
    console.log.apply(console, arguments);
}

function beginTest(name) {
    console.log("Starting", name);
}

function endTest(name, failures) {
    console.log("Ending", name, failures ? " - failed" : " - success");
}

var paint = function () {};
var fb32 = new Uint32Array(1280 * 1024);
test.run(log, beginTest, endTest, fb32, paint).then(function (fails) {
    if (fails) process.exit(1);
});
