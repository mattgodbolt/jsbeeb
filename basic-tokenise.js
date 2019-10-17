define(['utils', 'models', 'fake6502', 'promise'],
    function (utils, models, Fake6502) {
        "use strict";

        function create() {
            var cpu = Fake6502.fake6502(models.basicOnly);
            var callTokeniser = function (line) {
                // With thanks to http://8bs.com/basic/basic4-8db2.htm
                cpu.pc = 0x8db2;
                cpu.s = 0xf0;
                var offset = 0x1000;
                cpu.writemem(0x3b, 0x00);
                cpu.writemem(0x3c, 0x00);
                cpu.writemem(0x37, offset & 0xff);
                cpu.writemem(0x38, (offset >>> 8) & 0xff);
                cpu.writemem(0xfe30, 12);
                for (var i = 0; i < line.length; ++i) {
                    cpu.writemem(offset + i, line.charCodeAt(i));
                }
                cpu.writemem(offset + line.length, 0x0d);
                var safety = 20 * 1000 * 1000;
                while (cpu.s <= 0xf0) {
                    cpu.execute(1);
                    if (--safety === 0) {
                        break;
                    }
                }
                var result = "";
                for (i = offset; cpu.readmem(i) !== 0x0d; ++i) {
                    result += String.fromCharCode(cpu.readmem(i));
                }
                if (safety === 0) {
                    throw new Error("Unable to tokenize '" + line + "' - got as far as '" + result + "' pc=" + utils.hexword(cpu.pc));
                }
                return result;
            };
            var lineRe = /^([0-9]+)?(.*)/;
            var tokeniseLine = function (line, lineNumIfNotSpec) {
                var lineSplit = line.match(lineRe);
                var lineNum = lineSplit[1] ? parseInt(lineSplit[1]) : lineNumIfNotSpec;
                var tokens = callTokeniser(lineSplit[2]);
                return '\r' +
                    String.fromCharCode((lineNum >>> 8) & 0xff) +
                    String.fromCharCode(lineNum & 0xff) +
                    String.fromCharCode(tokens.length + 4) + tokens;
            };
            var tokenise = function (text) {
                var result = "";
                text.split("\n").forEach(function (line, i) {
                    if (line) {
                        result += tokeniseLine(line, 10 + i * 10);
                    }
                });
                return result + "\r\xff";
            };
            return cpu.initialise().then(function () {
                return Promise.resolve({
                    tokenise: tokenise
                });
            });
        }

        return {
            create: create
        };
    });
