// To be run directly from 'js' or 'd8'.

///////////////////////////////////////////////////
// Enough of the code assumes there's a console.log that I've just made one here
var console = {
    log: function () {
        print.apply(console, arguments);
    }
};
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// Gook to simulate enough of requirejs to get Video to load
load('./lib/require.js');
requirejs.load = function (context, moduleName, url) {
    "use strict";
    load(url);
    context.completeLoad(moduleName);
};
requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min'
    }
});
function setTimeout(fn, delay) {
    fn();
}
///////////////////////////////////////////////////

///////////////////////////////////////////////////
requirejs(['video', '6502', 'soundchip', 'fdc', 'models'],
    function (Video, Cpu6502, SoundChip, disc, models) {
        "use strict";
        var frame = 0;
        var video = new Video.FakeVideo();
        var soundChip = new SoundChip.FakeSoundChip();

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
        var cpu = new Cpu6502(models.findModel('B'), dbgr, video, soundChip);
        cpu.initialise().then(function () {
            return disc.load("discs/" + discName + ".ssd");
        }).then(function (data) {
            cpu.fdc.loadDisc(0, disc.discFor(cpu.fdc, false, data));
            cpu.sysvia.keyDown(16);
            cpu.execute(10 * 1000 * 1000);
            cpu.sysvia.keyUp(16);
            benchmarkCpu(cpu, 100 * 1000 * 1000);
        }).catch(function (err) {
            "use strict";
            console.log("Got error: ", err);
        });
    }
);
