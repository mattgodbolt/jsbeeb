require(['jquery', 'tests/test'], function ($, test) {
    "use strict";
    var currentTest = null;

    function log() {
        console.log.apply(console, arguments);
        var msg = Array.prototype.join.call(arguments, " ");
        if (currentTest) {
            currentTest.find(".template").clone().removeClass("template").text(msg).appendTo(currentTest);
        }
    }

    function beginTest(name) {
        currentTest = $('#test-info > .template').clone().removeClass("template").appendTo($('#test-info'));
        currentTest.find(".test-name").text(name);
    }

    function endTest(name, failures) {
        if (!failures) {
            currentTest.addClass("success");
        } else {
            currentTest.addClass("fail");
        }
    }

    $(function () {
        var canvas = $('#screen');
        var fb32;
        var paint = function () {
        };
        if (canvas.length) {
            canvas = $('#screen')[0];
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, 1280, 768);
            if (!ctx.getImageData) {
                window.alert('Unsupported browser');
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
            paint = function (minx, miny, maxx, maxy) {
                frames++;
                var width = maxx - minx;
                var height = maxy - miny;
                backCtx.putImageData(imageData, 0, 0, minx, miny, width, height);
                ctx.drawImage(backBuffer, minx, miny, width, height, 0, 0, canvasWidth, canvasHeight);
            };

            fb32 = new Uint32Array(fb8.buffer);
        } else {
            fb32 = new Uint32Array(1280 * 1024);
        }
        test.run(log, beginTest, endTest, fb32, paint);
    });
});
