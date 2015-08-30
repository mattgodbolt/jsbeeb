var requirejs = require('requirejs');
var Png = require('png').Png;
var fs = require('fs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['video', '6502', 'soundchip', 'fdc', 'models'],
    function (Video, Cpu6502, SoundChip, disc, models) {
        var fb32 = new Uint32Array(1280 * 768);
        var frame = 0;
        var screenshotRequest = null;
        var video = new Video(fb32, function (minx, miny, maxx, maxy) {
            frame++;
            if (screenshotRequest) {
                var width = maxx - minx;
                var height = maxy - miny;
                var buf = new Buffer(width * height * 3);
                var addr = 0;
                for (var y = miny; y < maxy; ++y) {
                    for (var x = minx; x < maxx; ++x) {
                        var col = fb32[1280 * y + x];
                        buf[addr++] = col & 0xff;
                        buf[addr++] = (col >>> 8) & 0xff;
                        buf[addr++] = (col >>> 16) & 0xff;
                    }
                }
                var png = new Png(buf, width, height);
                var pngImage = png.encodeSync();
                console.log("Saving " + width + "x" + height + " screenshot to " + screenshotRequest);
                fs.writeFileSync(screenshotRequest, pngImage.toString('binary'), 'binary');
                screenshotRequest = null;
            }
        });
        var dbgr = {
            setCpu: function () {
            }
        };
        var soundChip = new SoundChip(10000);

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

        var discName = "elite";
        var cpu = new Cpu6502(models.findModel('B'), dbgr, video, soundChip);
        cpu.initialise().then(function () {
            return disc.load("discs/" + discName + ".ssd");
        }).then(function (data) {
            cpu.fdc.loadDisc(0, disc.discFor(cpu.fdc, false, data));
            cpu.sysvia.keyDown(16);
            cpu.execute(10 * 1000 * 1000);
            cpu.sysvia.keyUp(16);
            for (var i = 0; i < 10; ++i) {
                screenshotRequest = "/tmp/" + discName + "-" + i + ".png";
                benchmarkCpu(cpu, 10 * 1000 * 1000);
            }
        }).catch(function (err) {
            "use strict";
            console.log("Got error: ", err);
        });
    });
