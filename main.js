var processor;
var video;
var dbgr;
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
    var imageData = ctx.getImageData(0, 0, 1280, 768);
    var fb8 = imageData.data;
    function paint() {
        frames++;
        ctx.putImageData(imageData, 0, 0);
    };
    var fb32 = new Uint32Array(fb8.buffer);
    video = new video(fb32, paint);

    dbgr = new Debugger();
    function keyCode(evt) {
        return evt.which || evt.charCode || evt.keyCode;
    }
    function keyPress(evt) {
        if (!running) {
            return dbgr.keyPress(keyCode(evt)); 
        }
    }
    function keyDown(evt) {
        if (running) {
            var code = keyCode(evt);
            if (code === 36) {  // home
                stop();
            } else if (code == 123) { // F12
                processor.reset();
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

    processor = new cpu6502(dbgr, video);
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
    //processor.debugInstruction = function(pc) {return (pc === 0xbfea);};
    processor.execute(1000 * 1400);
    go();
})

function frame() {
    processor.execute(2 * 1000 * 1000 / 50);
}

var running = false;

function run() {
    if (!running) return;
    frame();
    setTimeout(run, 1000/50);
}

function go() {
    running = true;
    run();
}

function stop() {
    running = false; 
    processor.stop();
}
