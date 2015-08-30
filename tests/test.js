define(['video', 'soundchip', '6502', 'fdc', 'utils', 'models', 'cmos'],
    function (Video, SoundChip, Cpu6502, fdc, utils, models, Cmos) {
        var processor;
        var video;
        var soundChip;
        var dbgr;
        var MaxCyclesPerIter = 100 * 1000;
        var hexword = utils.hexword;
        var failures = 0;
        var anyFailures = false;
        var log, beginTest, endTest;

        var tests = [
            { test: "Test BCD (65C12)", func: testBCD, model: 'Master'},
            { test: "Test BCD (6502)", func: testBCD},
            { test: "Test timings", func: testTimings},
            { test: "Alien8 protection", func: function () { return testKevinEdwards("ALIEN8"); }},
            { test: "Nightshade protection", func: function () { return testKevinEdwards("NIGHTSH"); }},
            { test: "Lunar Jetman protection", func: function () { return testKevinEdwards("JETMAN"); }}
        ];

        function run(log_, beginTest_, endTest_, frameBuffer, paint) {
            log = log_;
            beginTest = beginTest_;
            endTest = endTest_;
            video = new Video(frameBuffer, paint);
            soundChip = new SoundChip(10000);
            dbgr = {
                setCpu: function () {
                }
            };

            return tests.reduce(function (p, test) {
                return p.then(function () {
                    return runTest(test.test, test.func, test.model);
                });
            }, Promise.resolve()).catch(function (err) {
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

        function runUntilInput() {
            log("Running until keyboard input requested");
            var idleAddr = processor.model.isMaster ? 0xe7e6 : 0xe581;
            var hit = false;
            var hook = processor.debugInstruction.add(function (addr) {
                if (addr === idleAddr) {
                    hit = true;
                    return true;
                }
            });
            return runFor(250 * 1000 * 1000).then(function () {
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

        function type(text) {
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
                } else if (ch === '*') {
                    ch = utils.keyCodes.APOSTROPHE;
                    shift = true;
                } else if (ch === '.') {
                    ch = utils.keyCodes.PERIOD;
                } else
                    ch = ch.toUpperCase().charCodeAt(0);
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

            return text.split("").reduce(function (p, char) {
                return p.then(function () {
                    "use strict";
                    return typeChar(char);
                });
            }, Promise.resolve()).then(function () {
                return kd(13);
            });
        }

        var currentTest = null;

        function log() {
            console.log.apply(console, arguments);
            var msg = Array.prototype.join.call(arguments, " ");
            if (currentTest) {
                currentTest.find(".template").clone().removeClass("template").text(msg).appendTo(currentTest);
            }
        }

        function expectEq(expected, actual, msg) {
            if (actual !== expected) {
                log(msg, "failure - actual", hexword(actual), "expected", hexword(expected));
                failures++;
            }
        }

        function testTimings() {
            var expected = [
                0x4436, 0x00, 0xDD,
                0x4443, 0x00, 0xDD,
                0x4450, 0x00, 0xDD,
                0x445E, 0x00, 0xDD,
                0x0000, 0x00, 0x00,
                0x0000, 0x00, 0x00,
                0x4488, 0x00, 0xFF,
                0x4497, 0x00, 0x00,
                0x0000, 0x00, 0x00,
                0x44B8, 0xC0, 0xFF,
                0x44C5, 0xC0, 0xFF,
                0x0000, 0x00, 0x00,
                0x0000, 0x00, 0x00,
                0x44F6, 0xC0, 0xDB,
                0x4506, 0xC0, 0xDC,
                0x4516, 0xC0, 0xFF,
                0x4527, 0xC0, 0x00,
                0x453A, 0xC0, 0x01,
                0x454A, 0xC0, 0x01,
                0x4559, 0xC0, 0x00,
                0x4569, 0xC0, 0x00,
                0x4578, 0xC0, 0x01,
                0x458A, 0xC0, 0xFF,
                0x4599, 0xC0, 0x00,
                0x45A6, 0xC0, 0x00,
                0x0000, 0x00, 0x00,
            ];
            return fdc.ssdLoad("discs/TestTimings.ssd").then(function (data) {
                processor.fdc.loadDisc(0, fdc.ssdFor(processor.fdc, data));
                return runUntilInput();
            }).then(function () {
                return type('CHAIN "TEST"');
            }).then(runUntilInput).then(function () {
                var num = processor.readmem(0x71) + 1;
                expectEq(expected.length / 3, num, "Different number of timings");
                for (var i = 0; i < num; ++i) {
                    var irqAddr = (processor.readmem(0x4300 + i) << 8) | processor.readmem(0x4000 + i);
                    var a = processor.readmem(0x4100 + i);
                    var b = processor.readmem(0x4200 + i);
                    expectEq(expected[i * 3 + 0], irqAddr, "IRQ address wrong at " + i);
                    expectEq(expected[i * 3 + 1], a, "A differed at " + i);
                    expectEq(expected[i * 3 + 2], b, "B differed at " + i);
                }
            });
        }

        function testBCD() {
            var output = "";
            var hook;
            return fdc.ssdLoad("discs/bcdtest.ssd").then(function (data) {
                processor.fdc.loadDisc(0, fdc.ssdFor(processor.fdc, data));
                return runUntilInput();
            }).then(function () {
                return type("*BCDTEST");
            }).then(function () {
                var printAddr = processor.model.isMaster ? 0xce52 : 0xc4c0;
                hook = processor.debugInstruction.add(function (addr) {
                    if (addr === printAddr) {
                        output += String.fromCharCode(processor.a);
                    }
                });
                return runUntilInput();
            }).then(function () {
                hook.remove();
                if (output.indexOf("PASSED") < 0) {
                    log("Failed: ", output);
                    failures++;
                }
            });
        }

        function testKevinEdwards(name) { // Well, at least his protection system...
            return fdc.ssdLoad("discs/Protection.ssd").then(function (data) {
                processor.fdc.loadDisc(0, fdc.ssdFor(processor.fdc, data));
                return runUntilInput();
            }).then(function () {
                return type('CHAIN "B.' + name + '"');
            }).then(function () {
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
            model = model || 'B';
            log("Running", name);
            beginTest(name);
            processor = new Cpu6502(models.findModel(model), dbgr, video, soundChip, new Cmos());
            failures = 0;
            return processor.initialise().then(func).then(function () {
                log("Finished", name);
                if (failures) anyFailures = true;
                endTest(name, failures);
            }).catch(function (err) {
                log("Caught error in", name, err, err.stack);
                anyFailures = true;
                endTest(name, true);
            });
        }

        return {
            setProcessor: function (proc) {
                processor = proc;
            },
            run: run,
            runUntilInput: runUntilInput,
            type: type
        };
    }
);
