var requirejs = require('requirejs');

requirejs.config({
    paths: {
        'jsunzip': 'lib/jsunzip',
        'underscore': 'lib/underscore-min'
    }
});

requirejs(['video', '6502', 'soundchip'],
    function (Video, Cpu6502, SoundChip) {
        var fb32 = new Uint32Array(1024 * 768);
        var frame = 0;
        var video = new Video(fb32, function () {
            frame++;
        });
        var dbgr = {
            setCpu: function () {
            }
        };
        var soundChip = new SoundChip(10000);
        soundChip.toneGenerator = {
            mute: function () {
            },
            tone: function () {
            }
        };

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

        var cpu = new Cpu6502(dbgr, video, soundChip);
        cpu.execute(10 * 1000 * 1000);
        benchmarkCpu(cpu, 10 * 1000 * 1000);
        benchmarkCpu(cpu, 10 * 1000 * 1000);
    });
