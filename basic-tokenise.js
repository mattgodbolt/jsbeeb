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
                var result = "";
                while (cpu.s <= 0xf0) {
                    cpu.execute(1);
                    if (--safety === 0) {
                        break;
                    }
                    if (cpu.pc === 0x8ea1) {
                        // Intercept the subroutine in the BASIC ROM which replaces a keyword
                        // with a token and copies down the tail of the line.  The 6502 code
                        // uses the Y register to index the copy and fails if the untokenised
                        // tail is longer than 255 bytes.  It also makes tokenisation O(n²)
                        // for a line with a lot of tokens.
                        //
                        // Instead we copy out the newly processed part and advance the pointer
                        // in 0x37/0x38 to the unprocessed part.
                        let to = cpu.readmemZpStack(0x38) << 8 | cpu.readmemZpStack(0x37);
                        while (offset < to) {
                            result += String.fromCharCode(cpu.readmem(offset));
                            offset++;
                        }
                        result += String.fromCharCode(cpu.a);
                        offset += cpu.y;
                        cpu.writememZpStack(0x37, offset & 0xff);
                        cpu.writememZpStack(0x38, (offset >>> 8) & 0xff);
                        ++offset;
                        cpu.pc = 0x8ea4;
                    }
                }
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
                if (tokens.length > 251) {
                    throw new Error("Line " + lineNum + " tokenised length " + tokens.length + " > 251 bytes");
                }
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
