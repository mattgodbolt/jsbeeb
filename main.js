$(function() {
    canvas = $('#screen')[0];
    ctx = canvas.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 1280, 768);
    if (!ctx.getImageData) {
        alert('Unsupported browser');
        return;
    }
    imageData = ctx.getImageData(0, 0, 1280, 768);
    imageDataData = imageData.data;
})
