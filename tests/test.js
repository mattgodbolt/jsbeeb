define(['video', 'soundchip', '6502', 'fdc', 'utils'],
    function (Video, SoundChip, Cpu6502, fdc, utils) {
        var processor;
        var video;
        var soundChip;
        var dbgr;
        var MaxCyclesPerIter = 100 * 1000;
        var hexword = utils.hexword;
        var failures = 0;
        var log, beginTest, endTest;

        var tests = [
            { test: "Test timings", func: testTimings },
            { test: "Alien8 protection", func: function (whenDone) {
                testKevinEdwards("ALIEN8", whenDone);
            } },
            { test: "Nightshade protection", func: function (whenDone) {
                testKevinEdwards("NIGHTSH", whenDone);
            } },
            { test: "Lunar Jetman protection", func: function (whenDone) {
                testKevinEdwards("JETMAN", whenDone);
            } }
        ];
        var testIdx = 0;

        function nextTest() {
            if (testIdx === tests.length) {
                log("All tests complete");
            } else {
                runTest(tests[testIdx].test, tests[testIdx].func, function () {
                    testIdx++;
                    nextTest();
                });
            }
        }

        function run(log_, beginTest_, endTest_, frameBuffer, paint) {
            log = log_;
            beginTest = beginTest_;
            endTest = endTest_;
            video = new Video(frameBuffer, paint);
            soundChip = new SoundChip(10000);
            dbgr = { setCpu: function () {} };

            nextTest();
        }

        function runFor(cycles, whenDone) {
            var left = cycles;
            var stopped = false;
            var now = function () {
                var todo = Math.max(0, Math.min(left, MaxCyclesPerIter));
                if (todo) {
                    stopped = !processor.execute(todo);
                    left -= todo;
                }
                if (left && !stopped) {
                    setTimeout(now, 0);
                } else {
                    whenDone();
                }
            };
            now();
        }

        function runUntilInput(whenDone) {
            log("Running until keyboard input requested");
            var prev = processor.debugInstruction;
            processor.debugInstruction = function (addr) {
                return addr === 0xe581;
            };
            runFor(10 * 1000 * 1000, function () {
                processor.debugInstruction = prev;
                runFor(10 * 1000, whenDone);
            });
        }

        function runUntilAddress(targetAddr, maxInstr, whenDone) {
            log("Running until $" + hexword(targetAddr));
            var prev = processor.debugInstruction;
            var hit = false;
            processor.debugInstruction = function (addr) {
                if (addr === targetAddr) {
                    hit = true;
                    return true;
                }
                return prev ? prev.apply(prev, arguments) : false;
            };
            runFor(maxInstr, function () {
                processor.debugInstruction = prev;
                whenDone(hit);
            });
        }

        function type(text, whenDone) {
            log("Typing '" + text + "'");
            var cycles = 40 * 1000;

            function atTheEnd() {
                processor.sysvia.keyDown(13);
                runFor(cycles, function () {
                    processor.sysvia.keyUp(13);
                    runFor(cycles, whenDone);
                });
            }

            function kd(ch, whenDone) {
                processor.sysvia.keyDown(ch);
                runFor(cycles, function () {
                    processor.sysvia.keyUp(ch);
                    runFor(cycles, whenDone);
                });
            }

            function typeChar(c, whenDone) {
                var ch = text[i].toUpperCase();
                var shift = false;
                if (ch === '"') {
                    ch = "2";
                    shift = true;
                } else if (ch == '.') {
                    ch = "\xbe";
                }
                ch = ch.charCodeAt(0);
                if (shift) {
                    processor.sysvia.keyDown(16);
                    runFor(cycles, function () {
                        kd(ch, function () {
                            processor.sysvia.keyUp(16);
                            runFor(cycles, whenDone);
                        });
                    });
                } else {
                    kd(ch, whenDone);
                }
            }

            var i = 0;

            function typeNext() {
                if (i === text.length) {
                    atTheEnd();
                } else {
                    typeChar(text[i], function () {
                        i = i + 1;
                        typeNext();
                    });
                }
            }

            typeNext();
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

        function testTimings(whenDone) {
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
            processor.fdc.loadDiscData(0, fdc.ssdLoad("/discs/TestTimings.ssd"));
            runUntilInput(function () {
                type('CHAIN "TEST"', function () {
                    runUntilInput(function () {
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
                        whenDone();
                    });
                });
            });
        }

        function testKevinEdwards(name, whenDone) { // Well, at least his protection system...
            processor.fdc.loadDiscData(0, fdc.ssdLoad("/discs/Protection.ssd"));
            runUntilInput(function () {
                type('CHAIN "B.' + name + '"', function () {
                    processor.debugInstruction = function (addr) {
                        if (addr === 0xfff4 && processor.a === 200 && processor.x === 3) {
                            log("Failed");
                            return true;
                        }
                        return false;
                    };
                    runUntilAddress(0xe00, 100 * 1000 * 1000, function (hit) {
                        expectEq(true, hit, "Decoded and hit end of protection");
                        whenDone();
                    });
                });
            });
        }

        function runTest(name, func, whenDone) {
            log("Running", name);
            beginTest(name);
            processor = new Cpu6502('B', dbgr, video, soundChip);
            failures = 0;
            func(function () {
                log("Finished", name);
                endTest(name, failures);
                whenDone();
            });
        }

        return { run: run };
    }
);
