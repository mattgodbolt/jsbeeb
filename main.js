var processor;
var video;
var soundChip;
var dbgr;
var jsAudioNode;  // has to remain to keep thing alive
var frames = 0;

$(function() {
    var canvas = $('#screen')[0];
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
    function paint(minx, miny, maxx, maxy) {
        frames++;
        //if ((frames & 0x1) != 0) return; TODO: frameskip
        var width = maxx-minx;
        var height = maxy-miny;
        backCtx.putImageData(imageData, 0, 0, minx, miny, width, height);
        ctx.drawImage(backBuffer, minx, miny, width, height, 0, 0, canvas.width, canvas.height);
    };
    var fb32 = new Uint32Array(fb8.buffer);
    video = new video(fb32, paint);

    soundChip = (function() {
        var context = null;
        if (typeof AudioContext !== 'undefined') {
            context = new AudioContext();
        } else if (typeof(webkitAudioContext) !== 'undefined') {
            context = new webkitAudioContext();
        } else {
            return new SoundChip(10000);
        }
        soundChip = new SoundChip(context.sampleRate);
        jsAudioNode = context.createScriptProcessor(1024, 0, 1);
        function pumpAudio(event) {
            var outBuffer = event.outputBuffer;
            var chan = outBuffer.getChannelData(0);
            soundChip.render(chan, 0, chan.length);
        }
        jsAudioNode.onaudioprocess = pumpAudio;
        jsAudioNode.connect(context.destination);
        return soundChip;
    })();

    dbgr = new Debugger();
    function keyCode(evt) {
        return evt.which || evt.charCode || evt.keyCode;
    }
    function keyPress(evt) {
        if (!running) {
            if (keyCode(evt) === 103) {
                dbgr.hide();
                go();
                return;
            }
            return dbgr.keyPress(keyCode(evt)); 
        }
    }
    function keyDown(evt) {
        if (running) {
            var code = keyCode(evt);
            if (code === 36) {  // home
                stop();
            } else if (code == 123) { // F12
                processor.reset(false);
                evt.preventDefault();
            } else {
                processor.sysvia.keyDown(keyCode(evt));
                evt.preventDefault();
            }
        }
    }
    function keyUp(evt) {
        if (running) {
            processor.sysvia.keyUp(keyCode(evt));
            evt.preventDefault();
        }
    }
    document.onkeydown = keyDown;
    document.onkeypress = keyPress;
    document.onkeyup = keyUp;

    processor = new cpu6502(dbgr, video, soundChip);
    //processor.debugread = function(mem) {
    //    if (mem === 0x983f) stop();
    //        //console.log(hexword(processor.pc), "Read of", hexword(mem));
    //};
    //processor.debugwrite = function(mem, v) {
    //    if (mem == 0xfd) {
    //        console.log(hexword(processor.oldpc), "Write to", hexword(mem), hexbyte(v));
    //        //processor.stop();
    //    }
    //}
    //processor.debugInstruction = function(pc) {
        //return (pc == 0xec5);
    //};
    //    if (pc == 0xfff7) {
    //        var addr = processor.x + (processor.y<<8);
    //        var oscli = "";
    //        for (;;) {
    //            var b = processor.readmem(addr);
    //            addr++;
    //            if (b == 13) break;
    //            oscli += String.fromCharCode(b);
    //        }
    //        console.log("OSCLI:", oscli);
    //    }
    //    return false;
    //};

    $('#disc_load').change(function(evt) { 
        var file = evt.target.files[0]; 
        var reader = new FileReader();
        reader.onload = function(e) {
            processor.fdc.loadDiscData(0, e.target.result);
        };
        reader.readAsBinaryString(file);
    });

    go();
})

const framesPerSecond = 50;
const targetTimeout = 1000 / framesPerSecond;
var adjustedTimeout = targetTimeout;
var lastFrame = null;
const clocksPerSecond = 2 * 1000 * 1000;
const cyclesPerFrame = clocksPerSecond / framesPerSecond;
const yieldsPerFrame = 1;
const cyclesPerYield = cyclesPerFrame / yieldsPerFrame;

function run() {
    if (!running) return;
    var now = Date.now();
    if (lastFrame) {
        // Try and tweak the timeout to achieve target frame rate.
        var timeSinceLast = now - lastFrame;
        if (timeSinceLast < 2 * targetTimeout) {
            // Ignore huge delays (e.g. trips in and out of the debugger)
            var diff = timeSinceLast - targetTimeout;
            adjustedTimeout -= 0.01 * diff;
        }
    }
    lastFrame = now;
    setTimeout(run, adjustedTimeout);

    var count = 0;
    var runner = function() {
        if (!running) return;
        if (count++ == yieldsPerFrame) return;
        try {
            processor.execute(cyclesPerYield);
        } catch (e) {
            running = false;
            throw e;
        }
        if (running) setTimeout(runner, 0);
    };
    runner();
}

function go() {
    running = true;
    run();
}

function stop() {
    running = false; 
    processor.stop();
}
