define([], function () {
    "use strict";

    var BASIC_TOKENS = [
        'AND', 'DIV', 'EOR', 'MOD', 'OR', 'ERROR', 'LINE', 'OFF',
        'STEP', 'SPC', 'TAB(', 'ELSE', 'THEN', '<line>' // TODO
        , 'OPENIN', 'PTR',

        'PAGE', 'TIME', 'LOMEM', 'HIMEM', 'ABS', 'ACS', 'ADVAL', 'ASC',
        'ASN', 'ATN', 'BGET', 'COS', 'COUNT', 'DEG', 'ERL', 'ERR',

        'EVAL', 'EXP', 'EXT', 'FALSE', 'FN', 'GET', 'INKEY', 'INSTR(',
        'INT', 'LEN', 'LN', 'LOG', 'NOT', 'OPENUP', 'OPENOUT', 'PI',

        'POINT(', 'POS', 'RAD', 'RND', 'SGN', 'SIN', 'SQR', 'TAN',
        'TO', 'TRUE', 'USR', 'VAL', 'VPOS', 'CHR$', 'GET$', 'INKEY$',

        'LEFT$(', 'MID$(', 'RIGHT$(', 'STR$', 'STRING$(', 'EOF',
        '<ESCFN>', '<ESCCOM>', '<ESCSTMT>',
        'WHEN', 'OF', 'ENDCASE', 'ELSE', 'ENDIF', 'ENDWHILE', 'PTR',

        'PAGE', 'TIME', 'LOMEM', 'HIMEM', 'SOUND', 'BPUT', 'CALL', 'CHAIN',
        'CLEAR', 'CLOSE', 'CLG', 'CLS', 'DATA', 'DEF', 'DIM', 'DRAW',

        'END', 'ENDPROC', 'ENVELOPE', 'FOR', 'GOSUB', 'GOTO', 'GCOL', 'IF',
        'INPUT', 'LET', 'LOCAL', 'MODE', 'MOVE', 'NEXT', 'ON', 'VDU',

        'PLOT', 'PRINT', 'PROC', 'READ', 'REM', 'REPEAT', 'REPORT', 'RESTORE',
        'RETURN', 'RUN', 'STOP', 'COLOUR', 'TRACE', 'UNTIL', 'WIDTH', 'OSCLI'];

    function encodeGoto(num) {
        // see http://xania.org/200711/bbc-base-line-number-format.html
        var lo = num & 0xff;
        var hi = ((num >>> 8) & 0xff);
        var loTop = lo >>> 6;
        var hiTop = hi >>> 6;
        var firstByte = ((loTop << 4) | (hiTop << 2)) ^ 0x54;
        var secondByte = (lo & 0x3f) | 0x40;
        var thirdByte = (hi & 0x3f) | 0x40;
        return String.fromCharCode(141) + String.fromCharCode(firstByte) +
            String.fromCharCode(secondByte) +
            String.fromCharCode(thirdByte);
    }

    function tokeniseLine(line) {
        var result = "";
        while (line) {
            var found = null;
            for (var i = 0; i < BASIC_TOKENS.length; ++i) {
                var candidateToken = BASIC_TOKENS[i];
                if (candidateToken[0] == '<') continue;
                if (line.length >= candidateToken.length &&
                    line.substr(0, candidateToken.length) == candidateToken) {
                    result += String.fromCharCode(i + 0x80);
                    line = line.substr(candidateToken.length);
                    found = candidateToken;
                    break;
                }
            }
            if (!found) {
                result += line[0];
                line = line.substr(1);
            } else if (found == "GOTO") {
                // Skip whitespace
                while (line && line[0] == ' ') {
                    result += line[0];
                    line = line.substr(1);
                }
                // Parse out a number if it's there
                var match = line.match(/^([0-9]+)(.*)$/);
                if (match) {
                    var num = parseInt(match[1]);
                    line = match[2];
                    result += encodeGoto(num);
                }
            }
        }
        return result;
    }

    function tokenise(source) {
        var out = "";
        var lastLine = 0;
        var lines = source.split("\n");
        for (var i = 0; i < lines.length; ++i) {
            var line = lines[i];
            if (line == "") continue;
            var matched = line.match(/ *([0-9]+)?(.*)/);
            if (!matched) throw "Bad input line " + line;
            var lineNum = matched[1] ? parseInt(matched[1]) : lastLine + 10;
            lastLine = lineNum;
            var tokens = tokeniseLine(matched[2]);
            out = out + '\r' +
                String.fromCharCode(lineNum >>> 8) +
                String.fromCharCode(lineNum & 0xff) +
                String.fromCharCode(tokens.length + 4) + tokens;
        }
        out = out + '\r' + '\xff';
        return out;
    }

    return {
        tokenise: tokenise
    };
});