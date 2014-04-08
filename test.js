var processor;
var video;
var soundChip;
var dbgr;
var frames = 0;

function stop() {
}

function runUntilInput() {
    var prev = processor.debugInstruction;
    processor.debugInstruction = function(addr) {
        return addr === 0xe581;
    };
    processor.execute(10 * 1000 * 1000);
    processor.debugInstruction = prev;
    processor.execute(10 * 1000);
}

function runUntilAddress(targetAddr, maxInstr) {
    var prev = processor.debugInstruction;
    var hit = false;
    processor.debugInstruction = function(addr) {
        if (addr === targetAddr) {
            hit = true;
            return true;
        }
        return false;
    };
    processor.execute(maxInstr);
    processor.debugInstruction = prev;
    return hit;
}

function type(text) {
    var prev = processor.debugInstruction;
    var cycles = 40 * 1000;
    for (var i = 0; i < text.length; ++i) {
        var ch = text[i].toUpperCase();
        var shift = false;
        if (ch === '"') {
            ch = "2";
            shift = true;
        } else if (ch == '.') {
            ch = "\xbe";
        }
        ch = ch.charCodeAt(0);
        if (shift) {
            processor.sysvia.keyDown(16);
            processor.execute(cycles);
        }
        processor.sysvia.keyDown(ch);
        processor.execute(cycles);
        processor.sysvia.keyUp(ch);
        processor.execute(cycles);
        if (shift) {
            processor.sysvia.keyUp(16);
            processor.execute(cycles);
        }
    }
    processor.sysvia.keyDown(13);
    processor.execute(cycles);
    processor.sysvia.keyUp(13);
    processor.execute(cycles);
    processor.debugInstruction = prev;
}

function log() {
    console.log(arguments);
    var msg = Array.prototype.join.call(arguments, " ");
    var info = $('#test-info');
    info.text(info.text() + "\n" + msg);
}
var failures = 0;

function expectEq(expected, actual, msg) {
    if (actual !== expected) {
        log(msg, "failure - actual", hexword(actual), "expected", hexword(expected));
        failures++;
    }
}

function testTimings() {
    var expected = [
        0x4436, 0x00, 0xDD,
        0x4443, 0x00, 0xDD,
        0x4450, 0x00, 0xDD,
        0x445E, 0x00, 0xDD,
        0x0000, 0x00, 0x00,
        0x0000, 0x00, 0x00,
        0x4488, 0x00, 0xFF,
        0x4497, 0x00, 0x00,
        0x0000, 0x00, 0x00,
        0x44B8, 0xC0, 0xFF,
        0x44C5, 0xC0, 0xFF,
        0x0000, 0x00, 0x00,
        0x0000, 0x00, 0x00,
        0x44F6, 0xC0, 0xDB,
        0x4506, 0xC0, 0xDC,
        0x4516, 0xC0, 0xFF,
        0x4527, 0xC0, 0x00,
        0x453A, 0xC0, 0x01,
        0x454A, 0xC0, 0x01,
        0x4559, 0xC0, 0x00,
        0x4569, 0xC0, 0x00,
        0x4578, 0xC0, 0x01,
        0x458A, 0xC0, 0xFF,
        0x4599, 0xC0, 0x00,
        0x45A6, 0xC0, 0x00,
        0x0000, 0x00, 0x00,
        ];
    processor.fdc.loadDiscData(0, ssdLoad("discs/TestTimings.ssd"));
    runUntilInput();
    type('CHAIN "TEST"');
    runUntilInput();
    var num = processor.readmem(0x71) + 1;
    expectEq(expected.length / 3, num, "Different number of timings");
    for (var i = 0; i < num; ++i) {
        var irqAddr = (processor.readmem(0x4300 + i) << 8) | processor.readmem(0x4000 + i);
        var a = processor.readmem(0x4100 + i);
        var b = processor.readmem(0x4200 + i);
        expectEq(expected[i * 3 + 0], irqAddr, "IRQ address wrong at " + i);
        expectEq(expected[i * 3 + 1], a, "A differed at " + i);
        expectEq(expected[i * 3 + 2], b, "B differed at " + i);
    }
}

function alien8() {
    processor.fdc.loadDiscData(0, ssdLoad("discs/Protection.ssd"));
    runUntilInput();
    type('CHAIN "B.ALIEN8"');
    var hit = runUntilAddress(0xe00, 100 * 1000 * 1000);
    expectEq(true, hit, "Decoded and hit end of protection");
}

function runTest(name, func) {
    log("Running", name);
    processor = new Cpu6502(dbgr, video, soundChip);
    failures = 0;
    func();
    if (!failures) {
        log("Passed ok!");
    }
    log("Finished", name);
}

$(function() {
    var canvas = $('#screen')
    if (canvas.length) {
        canvas = $('#screen')[0];
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, 1280, 768);
        if (!ctx.getImageData) {
            alert('Unsupported browser');
            return;
        }
        var backBuffer = document.createElement("canvas");
        backBuffer.width = 1280;
        backBuffer.height = 768;
        var backCtx = backBuffer.getContext("2d");
        var imageData = backCtx.createImageData(backBuffer.width, backBuffer.height);
        var fb8 = imageData.data;
        var canvasWidth = canvas.width;
        var canvasHeight = canvas.height;
        function paint(minx, miny, maxx, maxy) {
            frames++;
            var width = maxx - minx;
            var height = maxy - miny;
            backCtx.putImageData(imageData, 0, 0, minx, miny, width, height);
            ctx.drawImage(backBuffer, minx, miny, width, height, 0, 0, canvasWidth, canvasHeight);
        }

        var fb32 = new Uint32Array(fb8.buffer);
        video = new Video(fb32, paint);
    } else {
        var fb32 = new Uint32Array(1280 * 1024);
        video = new Video(fb32, function() {});
    }
    soundChip = new SoundChip(10000);

    dbgr = new Debugger();

    runTest("Test timings", testTimings);
    runTest("Alien8 protection", alien8); 
});

