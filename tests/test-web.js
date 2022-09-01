require(["jquery", "tests/test"], function ($, test) {
    "use strict";
    let currentTest = null;

    function log() {
        console.log.apply(console, arguments);
        let msg = Array.prototype.join.call(arguments, " ");
        if (currentTest) {
            currentTest.find(".template").clone().removeClass("template").text(msg).appendTo(currentTest);
        }
    }

    function beginTest(name) {
        currentTest = $("#test-info > .template").clone().removeClass("template").appendTo($("#test-info"));
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
        let canvas = $("#screen");
        let fb32;
        let paint = function () {};
        if (canvas.length) {
            canvas = $("#screen")[0];
            let ctx = canvas.getContext("2d");
            ctx.fillStyle = "black";
            ctx.fillRect(0, 0, 1280, 768);
            if (!ctx.getImageData) {
                window.alert("Unsupported browser");
                return;
            }
            let backBuffer = document.createElement("canvas");
            backBuffer.width = 1280;
            backBuffer.height = 768;
            let backCtx = backBuffer.getContext("2d");
            let imageData = backCtx.createImageData(backBuffer.width, backBuffer.height);
            let fb8 = imageData.data;
            let canvasWidth = canvas.width;
            let canvasHeight = canvas.height;
            paint = function (minx, miny, maxx, maxy) {
                let width = maxx - minx;
                let height = maxy - miny;
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
