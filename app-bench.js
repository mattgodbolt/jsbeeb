var requirejs = require('requirejs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['fake6502', 'fdc', 'models'],
    function (Fake6502, disc, models) {
        "use strict";

        function benchmarkCpu(cpu, numCycles) {
            numCycles = numCycles || 10 * 1000 * 1000;
            console.log("Benchmarking over " + numCycles + " cpu cycles");
            var startTime = Date.now();
            cpu.execute(numCycles);
            var endTime = Date.now();
            var msTaken = endTime - startTime;
            var virtualMhz = (numCycles / msTaken) / 1000;
            console.log("Took " + msTaken + "ms to execute " + numCycles + " cycles");
            console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
        }

        var discName = "elite";
        var cpu = Fake6502.fake6502(models.findModel('B'));
        cpu.initialise().then(function () {
            return disc.load("discs/" + discName + ".ssd");
        }).then(function (data) {
            cpu.fdc.loadDisc(0, disc.discFor(cpu.fdc, '', data));
            cpu.sysvia.keyDown(16);
            cpu.execute(10 * 1000 * 1000);
            cpu.sysvia.keyUp(16);
            benchmarkCpu(cpu, 100 * 1000 * 1000);
        }).catch(function (err) {
            console.log("Got error: ", err);
        });
    }
);
