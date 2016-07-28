var requirejs = require('requirejs');

requirejs.config({
    baseUrl: ".",
    paths: {
        'jsunzip': 'lib/jsunzip',
        'promise': 'lib/promise-6.0.0',
        'underscore': 'lib/underscore-min',
        'test': 'tests/test'
    }
});

requirejs(['fake6502', 'utils'],
    function (Fake6502, utils) {
        "use strict";

        function runTest(processor, test, name) {
            return utils.loadData("tests/6502_65C02_functional_tests/bin_files/" + test + ".bin").then(function (data) {
                for (var i = 0; i < data.length; ++i)
                    processor.writemem(i, data[i]);
                processor.pc = 0x400;
                var log = false;
                processor.debugInstruction.add(function (addr, opcode) {
                    if (log) {
                        console.log(utils.hexword(addr) + " : " + utils.hexbyte(processor.a) + " : " + processor.disassembler.disassemble(processor.pc)[0]);
                    }

                    return addr !== 0x400 && addr === processor.getPrevPc(1);
                });
                console.log("Running Dormann " + name + " tests...");
                while (processor.execute(1000000)) {
                }
                return processor.pc;
            });
        }

        function fail(processor) {
            console.log("Failed at " + utils.hexword(processor.pc));
            console.log("Previous PCs:");
            for (var i = 1; i < 16; ++i) {
                console.log("  " + utils.hexword(processor.getPrevPc(i)));
            }
            console.log("A: " + utils.hexbyte(processor.a));
            console.log("X: " + utils.hexbyte(processor.x));
            console.log("Y: " + utils.hexbyte(processor.y));
            console.log("S: " + utils.hexbyte(processor.s));
            console.log("P: " + utils.hexbyte(processor.p.asByte()) + " " + processor.p.debugString());
            console.log(utils.hd(function (i) {
                return processor.readmem(i);
            }, 0x00, 0x40));
            process.exit(1);
        }

        var cpu6502 = Fake6502.fake6502();
        var test6502 = cpu6502.initialise().then(function () {
            return runTest(cpu6502, '6502_functional_test', '6502');
        }).then(function (addr) {
            // TODO: really should parse this from the lst file.
            // But for now update this if you ever update the submodule checkout.
            if (addr !== 0x3399)
                fail(cpu6502);
        });

        var test65c12 = test6502.then(function () {
            var cpu65c12 = Fake6502.fake65C12();
            return cpu65c12.initialise().then(function () {
                return runTest(cpu65c12, '65C12_extended_opcodes_test', '65C12');
            }).then(function (addr) {
                // TODO: really should parse this from the lst file.
                // But for now update this if you ever update the submodule checkout.
                if (addr !== 0x2373)
                    fail(cpu65c12);
            });
        });

        test65c12.then(function () {
            console.log("Success!");
        });
    }
);
