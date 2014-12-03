define([], function () {
    "use strict";

    function Canvas(canvas) {
        this.ctx = canvas.getContext('2d');
        this.ctx.fillStyle = 'black';
        this.ctx.fillRect(0, 0, 1280, 768);
        this.backBuffer = window.document.createElement("canvas");
        this.backBuffer.width = 1280;
        this.backBuffer.height = 768;
        this.backCtx = this.backBuffer.getContext("2d");
        this.imageData = this.backCtx.createImageData(this.backBuffer.width, this.backBuffer.height);
        this.canvasWidth = canvas.width;
        this.canvasHeight = canvas.height;

        this.fb32 = new Uint32Array(this.imageData.data.buffer);

        this.paint = function (minx, miny, maxx, maxy) {
            var width = maxx - minx;
            var height = maxy - miny;
            this.backCtx.putImageData(this.imageData, 0, 0, minx, miny, width, height);
            this.ctx.drawImage(this.backBuffer, minx, miny, width, height, 0, 0, this.canvasWidth, this.canvasHeight);
        };
    }

    return Canvas;
});