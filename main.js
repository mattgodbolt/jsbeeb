var processor;
var dbgr;

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
    var imageDataData = imageData.data;

    dbgr = new Debugger();
    processor = new cpu6502(dbgr);
    processor.execute(1000 * 1000);

    processor.stop();
})
