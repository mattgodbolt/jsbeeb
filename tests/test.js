"use strict";
import * as utils from "../utils.js";
import { Video } from "../video.js";
import * as fdc from "../fdc.js";
import { fake6502 } from "../fake6502.js";
import { findModel } from "../models.js";

var processor;
var video;
var MaxCyclesPerIter = 100 * 1000;
var hexword = utils.hexword;
var failures = 0;
var anyFailures = false;
var log, beginTest, endTest;

// TODO, should really use a consistent test harness for this...
var tests = [
    {
        test: "Alien8 protection",
        func: function () {
            return testKevinEdwards("ALIEN8");
        },
    },
    {
        test: "Nightshade protection",
        func: function () {
            return testKevinEdwards("NIGHTSH");
        },
    },
    {
        test: "Lunar Jetman protection",
        func: function () {
            return testKevinEdwards("JETMAN");
        },
    },
];

export function run(log_, beginTest_, endTest_, frameBuffer, paint) {
    log = log_;
    beginTest = beginTest_;
    endTest = endTest_;
    video = new Video(false, frameBuffer, paint);

    return tests
        .reduce(function (p, test) {
            return p.then(function () {
                return runTest(test.test, test.func, test.model);
            });
        }, Promise.resolve())
        .then(function () {
            return anyFailures;
        })
        .catch(function (err) {
            anyFailures = true;
            log(err);
        });
}

function runFor(cycles) {
    var left = cycles;
    var stopped = false;
    return new Promise(function (resolve) {
        var runAnIter = function () {
            var todo = Math.max(0, Math.min(left, MaxCyclesPerIter));
            if (todo) {
                stopped = !processor.execute(todo);
                left -= todo;
            }
            if (left && !stopped) {
                setTimeout(runAnIter, 0);
            } else {
                resolve();
            }
        };
        runAnIter();
    });
}

export function runUntilInput(secs) {
    if (!secs) secs = 120;
    log("Running until keyboard input requested");
    var idleAddr = processor.model.isMaster ? 0xe7e6 : 0xe581;
    var hit = false;
    var hook = processor.debugInstruction.add(function (addr) {
        if (addr === idleAddr) {
            hit = true;
            return true;
        }
    });
    return runFor(secs * 2 * 1000 * 1000).then(function () {
        hook.remove();
        if (!hit) log("Failed to hit breakpoint");
        return runFor(10 * 1000);
    });
}

function runUntilAddress(targetAddr, maxInstr) {
    log("Running until $" + hexword(targetAddr));
    var hit = false;
    var hook = processor.debugInstruction.add(function (addr) {
        if (addr === targetAddr) {
            hit = true;
            return true;
        }
    });
    return runFor(maxInstr).then(function () {
        hook.remove();
        return hit;
    });
}

export function type(text) {
    log("Typing '" + text + "'");
    var cycles = 40 * 1000;

    function kd(ch) {
        processor.sysvia.keyDown(ch);
        return runFor(cycles).then(function () {
            processor.sysvia.keyUp(ch);
            return runFor(cycles);
        });
    }

    function typeChar(ch) {
        var shift = false;
        if (ch === '"') {
            ch = 50;
            shift = true;
        } else if (ch === "*") {
            ch = utils.keyCodes.APOSTROPHE;
            shift = true;
        } else if (ch === ".") {
            ch = utils.keyCodes.PERIOD;
        } else ch = ch.toUpperCase().charCodeAt(0);
        if (shift) {
            processor.sysvia.keyDown(16);
            return runFor(cycles).then(function () {
                return kd(ch).then(function () {
                    processor.sysvia.keyUp(16);
                    return runFor(cycles);
                });
            });
        } else {
            return kd(ch);
        }
    }

    return text
        .split("")
        .reduce(function (p, char) {
            return p.then(function () {
                return typeChar(char);
            });
        }, Promise.resolve())
        .then(function () {
            return kd(13);
        });
}

var currentTest = null;

log = function () {
    console.log.apply(console, arguments);
    var msg = Array.prototype.join.call(arguments, " ");
    if (currentTest) {
        currentTest.find(".template").clone().removeClass("template").text(msg).appendTo(currentTest);
    }
};

function expectEq(expected, actual, msg) {
    if (actual !== expected) {
        log(msg, "failure - actual", hexword(actual), "expected", hexword(expected));
        failures++;
    }
}

function testKevinEdwards(name) {
    // Well, at least his protection system...
    return fdc
        .load("discs/Protection.ssd")
        .then(function (data) {
            processor.fdc.loadDisc(0, fdc.discFor(processor.fdc, "", data));
            return runUntilInput();
        })
        .then(function () {
            return type('CHAIN "B.' + name + '"');
        })
        .then(function () {
            var hook = processor.debugInstruction.add(function (addr) {
                if (addr === 0xfff4 && processor.a === 200 && processor.x === 3) {
                    log("Failed");
                    return true;
                }
                return false;
            });
            return runUntilAddress(0xe00, 100 * 1000 * 1000).then(function (hit) {
                hook.remove();
                expectEq(true, hit, "Decoded and hit end of protection");
            });
        });
}

function runTest(name, func, model) {
    model = model || "B-DFS1.2";
    log("Running", name);
    beginTest(name);
    processor = fake6502(findModel(model), { video: video });
    failures = 0;
    return processor
        .initialise()
        .then(func)
        .then(function () {
            log("Finished", name);
            if (failures) anyFailures = true;
            endTest(name, failures);
        })
        .catch(function (err) {
            log("Caught error in", name, err, err.stack);
            anyFailures = true;
            endTest(name, true);
        });
}
