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
       return dbgr.keyPress(keyCode(evt)); 
    }
    document.onkeypress = keyPress;

    processor = new cpu6502(dbgr, video);
    //processor.debugwrite = function(mem, v) {
    //    if (mem == 0x267) {
    //        console.log(hexword(processor.oldpc), "Write to", hexword(mem), hexbyte(v));
    //        //processor.stop();
    //    }
    //}
    // Run for three seconds.
    //processor.execute(3 * 2 * 1000 * 1000);
    processor.execute(1000 * 1200);

    processor.stop();
})
