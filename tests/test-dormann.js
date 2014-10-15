var requirejs = require('requirejs');

requirejs.config({
    baseUrl: ".",
    paths: {
        'jsunzip': 'lib/jsunzip',
        'underscore': 'lib/underscore-min',
        'test': 'tests/test'
    }
});

requirejs(['video', 'soundchip', '6502', 'utils', 'models'],
    function (Video, SoundChip, Cpu6502, utils, models) {
        "use strict";

        var paint = function () {
        };
        var video = new Video(new Uint32Array(1280 * 1024), paint);
        var soundChip = new SoundChip(10000);
        var dbgr = { setCpu: function () {
        } };

        function runTest(processor, test, name) {
            var data = utils.loadData("tests/6502_65C02_functional_tests/bin_files/" + test + ".bin");
            for (var i = 0; i < data.length; ++i)
                processor.writemem(i, data[i]);
            processor.pc = 0x400;
            processor.debugInstruction = function (addr) {
                if (addr !== 0x400 && addr === processor.getPrevPc(1)) {
                    // We hit a loop to ourself.
                    return true;
                }
                return false;
            };
            console.log("Running Dormann " + name + " tests...");
            while (processor.execute(1000000)) {
            }
            return processor.pc;
        }

        var addr = runTest(new Cpu6502(models.TEST_6502, dbgr, video, soundChip), '6502_functional_test', '6502');
        // TODO: really should parse this from the lst file.
        // But for now update this if you ever update the submodule checkout.
        if (addr !== 0x3399) {
            console.log("Failed at " + utils.hexword(addr));
            process.exit(1);
        }
        console.log("Success!");
    }
);
