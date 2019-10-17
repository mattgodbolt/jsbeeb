"use strict";
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

requirejs(['video', 'fake6502', 'fdc', 'models'],
    function (Video, Fake6502, disc, models) {
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

        var discName = "elite";
        var cpu = Fake6502.fake6502(models.findModel('B'), {video: video});
        cpu.initialise().then(function () {
            return disc.load("discs/" + discName + ".ssd");
        }).then(function (data) {
            cpu.fdc.loadDisc(0, disc.discFor(cpu.fdc, '', data));
            cpu.sysvia.keyDown(16);
            cpu.execute(10 * 1000 * 1000);
            cpu.sysvia.keyUp(16);
            for (var i = 0; i < 10; ++i) {
                screenshotRequest = "/tmp/" + discName + "-" + i + ".png";
                benchmarkCpu(cpu, 10 * 1000 * 1000);
            }
        }).catch(function (err) {
            console.log("Got error: ", err);
        });
    });
