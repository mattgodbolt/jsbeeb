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
    function keyCode(evt) {
        return evt.which || evt.charCode || evt.keyCode;
    }
    function keyPress(evt) {
       return dbgr.keyPress(keyCode(evt)); 
    }
    document.onkeypress = keyPress;

    processor = new cpu6502(dbgr);
    processor.execute(1000 * 1000);

    processor.stop();
})
