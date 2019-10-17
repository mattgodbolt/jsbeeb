// frogman runner, was useful in debugging the protection system.
var requirejs = require('requirejs');
var Png = require('node-png').PNG;
var fs = require('fs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['video', 'fake6502', 'soundchip', 'fdc', 'models', 'tests/test.js', 'utils'],
    function (Video, Fake6502, SoundChip, disc, models, test, utils) {
        "use strict";
        var fb32 = new Uint32Array(1280 * 768);
        var frame = 0;
        var screenshotRequest = null;
        var video = new Video.Video(false, fb32, function (minx, miny, maxx, maxy) {
            frame++;
            if (screenshotRequest) {
                var width = maxx - minx;
                var height = maxy - miny;
                var addr = 0;
                var png = new Png({width: width, height: height});
                for (var y = miny; y < maxy; ++y) {
                    for (var x = minx; x < maxx; ++x) {
                        var col = fb32[1280 * y + x];
                        png.data[addr++] = col & 0xff;
                        png.data[addr++] = (col >>> 8) & 0xff;
                        png.data[addr++] = (col >>> 16) & 0xff;
                        png.data[addr++] = 0xff;
                    }
                }
                console.log("Scheduling save of " + width + "x" + height + " screenshot to " + screenshotRequest);
                png.pack().pipe(fs.createWriteStream(screenshotRequest));
                screenshotRequest = null;
            }
        });

        function benchmarkCpu(cpu, numCycles) {
            numCycles = numCycles || 10 * 1000 * 1000;
            var startTime = Date.now();
            cpu.execute(numCycles);
            var endTime = Date.now();
            var msTaken = endTime - startTime;
            var virtualMhz = (numCycles / msTaken) / 1000;
            console.log("Took " + msTaken + "ms to execute " + numCycles + " cycles");
            console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
        }

        var discName = "frogman";
        var cpu = Fake6502.fake6502(models.findModel('B'), {video: video});
        test.setProcessor(cpu);
        cpu.initialise().then(function () {
            return disc.load("discs/" + discName + ".ssd");
        }).then(function (data) {
            cpu.fdc.loadDisc(0, disc.discFor(cpu.fdc, '', data));
            var trace = false;
            cpu.debugInstruction.add(function (addr) {
                //if (addr === 0x11ae) {
                if (addr === 0x2949) {
                    cpu.dumpTime();
                    trace = true;
                    //return true;
                } else if (trace && addr >= 0x29fd) {
                    trace = false;
                    return true;
                }
            });
            cpu.debugWrite.add(function (addr, val) {
                if (trace) {
                    console.log(utils.hexword(cpu.pc) + ": " + utils.hexword(addr) + " => " + utils.hexbyte(val));
                }
            });
            cpu.debugRead.add(function (addr, val) {
                if (trace) {
                    console.log(utils.hexword(cpu.pc) + ": " + utils.hexword(addr) + " <= " + utils.hexbyte(val));
                }
            });
            cpu.sysvia.disableKeyboard();
            cpu.sysvia.keyToggleRaw(utils.BBC.SHIFT);

            function exec(c) {
                //var thing = 2000000;
                var thing = 1;
                while (c > thing) {
                    if (!cpu.execute(thing)) return false;
                    c -= thing;
                }
                return cpu.execute(c);
            }

            var first = 1564809;
            console.log(first);
            exec(first);
            console.log("now = " + cpu.currentCycles + " " + utils.hexword(cpu.pc));
            cpu.sysvia.enableKeyboard();
            var second = 2097489 - cpu.currentCycles;
            console.log(second);
            exec(second);
            console.log("now = " + cpu.currentCycles + " " + utils.hexword(cpu.pc));
            cpu.sysvia.keyDown(49);
            var third = 2363365 - cpu.currentCycles;
            console.log(third);
            exec(third);
            console.log("now = " + cpu.currentCycles + " " + utils.hexword(cpu.pc));
            cpu.sysvia.keyUp(49);
            console.log("Typed 1");
            for (var i = 0; i < 2; ++i) {
                screenshotRequest = "/tmp/" + discName + "-" + i + ".png";
                console.log("At " + utils.hexword(cpu.pc));
                if (!exec(10 * 1000 * 1000)) break;
            }
            console.log("At " + utils.hexword(cpu.pc));
            screenshotRequest = "/tmp/" + discName + "-end.png";
            cpu.execute(1000 * 1000);
        }).catch(function (err) {
            console.log("Got error: ", err);
        });
    });
