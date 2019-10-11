define(['webgl-debug'], function (webglDebug) {
    "use strict";

    function Canvas(canvas) {
        this.ctx = canvas.getContext('2d');
        if (this.ctx === null) throw new Error("Unable to get a 2D context");
        this.ctx.fillStyle = 'black';
        this.ctx.fillRect(0, 0, 1024, 625);
        this.backBuffer = window.document.createElement("canvas");
        this.backBuffer.width = 1024;
        this.backBuffer.height = 625;
        this.backCtx = this.backBuffer.getContext("2d");
        this.imageData = this.backCtx.createImageData(this.backBuffer.width, this.backBuffer.height);
        this.canvasWidth = canvas.width;
        this.canvasHeight = canvas.height;

        this.fb32 = new Uint32Array(this.imageData.data.buffer);
    }

    Canvas.prototype.paint = function (minx, miny, maxx, maxy) {
        var width = maxx - minx;
        var height = maxy - miny;
        this.backCtx.putImageData(this.imageData, 0, 0, minx, miny, width, height);
        this.ctx.drawImage(this.backBuffer, minx, miny, width, height, 0, 0, this.canvasWidth, this.canvasHeight);
    };

    function GlCanvas(canvas) {
        // failIfMajorPerformanceCaveat prevents the use of CPU based WebGL
        // rendering, which is much worse than simply using a 2D canvas for
        // rendering.
        var glAttrs = { alpha: false,
                        antialias: false,
                        depth: false,
                        preserveDrawingBuffer: false,
                        stencil: false,
                        failIfMajorPerformanceCaveat: true };
        var gl = canvas.getContext('webgl', glAttrs) || canvas.getContext('experimental-webgl', glAttrs);
        this.gl = gl;
        if (!gl) {
            throw new Error("Unable to create a GL context");
        }
        var checkedGl = webglDebug.makeDebugContext(gl, function (err, funcName) {
            throw new Error("Problem creating GL context: " + webglDebug.glEnumToString(err) + " in " + funcName);
        });

        checkedGl.depthMask(false);

        function compileShader(type, src) {
            var shader = checkedGl.createShader(type);
            checkedGl.shaderSource(shader, src.join("\n"));
            checkedGl.compileShader(shader);
            return shader;
        }

        var vertexShader = compileShader(checkedGl.VERTEX_SHADER, [
            "attribute vec2 pos;",
            "attribute vec2 uvIn;",
            "varying vec2 uv;",
            "void main() {",
            "  uv = uvIn;",
            "  gl_Position = vec4(2.0 * pos - 1.0, 0.0, 1.0);",
            "}"
        ]);
        var fragmentShader = compileShader(checkedGl.FRAGMENT_SHADER, [
            "precision mediump float;",
            "uniform sampler2D tex;",
            "varying vec2 uv;",
            "void main() {",
            "  gl_FragColor = texture2D(tex, uv).rgba;",
            "}"
        ]);

        var program = checkedGl.createProgram();
        checkedGl.attachShader(program, fragmentShader);
        checkedGl.attachShader(program, vertexShader);
        checkedGl.linkProgram(program);
        checkedGl.useProgram(program);

        var width = 1024;
        var height = 1024;

        this.fb8 = new Uint8Array(width * height * 4);
        this.fb32 = new Uint32Array(this.fb8.buffer);
        this.texture = checkedGl.createTexture();
        checkedGl.bindTexture(checkedGl.TEXTURE_2D, this.texture);
        checkedGl.pixelStorei(checkedGl.UNPACK_ALIGNMENT, 4);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_S, checkedGl.CLAMP_TO_EDGE);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_T, checkedGl.CLAMP_TO_EDGE);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_MAG_FILTER, checkedGl.LINEAR);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_MIN_FILTER, checkedGl.LINEAR);
        checkedGl.texImage2D(checkedGl.TEXTURE_2D, 0, checkedGl.RGBA, width, height, 0, checkedGl.RGBA, checkedGl.UNSIGNED_BYTE, this.fb8);
        checkedGl.bindTexture(checkedGl.TEXTURE_2D, null);

        checkedGl.uniform1i(checkedGl.getUniformLocation(program, 'tex'), 0);

        var vertexPositionAttrLoc = checkedGl.getAttribLocation(program, 'pos');
        checkedGl.enableVertexAttribArray(vertexPositionAttrLoc);
        var vertexPositionBuffer = checkedGl.createBuffer();
        checkedGl.bindBuffer(checkedGl.ARRAY_BUFFER, vertexPositionBuffer);
        checkedGl.bufferData(checkedGl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), checkedGl.STATIC_DRAW);
        checkedGl.vertexAttribPointer(vertexPositionAttrLoc, 2, checkedGl.FLOAT, false, 0, 0);

        var uvAttrLoc = checkedGl.getAttribLocation(program, 'uvIn');
        checkedGl.enableVertexAttribArray(uvAttrLoc);
        var uvBuffer = checkedGl.createBuffer();
        checkedGl.bindBuffer(checkedGl.ARRAY_BUFFER, uvBuffer);
        checkedGl.vertexAttribPointer(uvAttrLoc, 2, checkedGl.FLOAT, false, 0, 0);

        checkedGl.activeTexture(gl.TEXTURE0);
        checkedGl.bindTexture(gl.TEXTURE_2D, this.texture);

        var uvFloatArray = new Float32Array(8);
        var lastMinX, lastMinY, lastMaxX, lastMaxY;
        this.paint = function (minx, miny, maxx, maxy) {
            var gl = this.gl;
            // We can't specify a stride for the source, so have to use the full width.
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, miny, width, maxy - miny, gl.RGBA, gl.UNSIGNED_BYTE, this.fb8.subarray(miny * width * 4, maxy * width * 4));

            if (lastMinX !== minx || lastMinY !== miny || lastMaxX !== maxx || lastMaxY !== maxy) {
                lastMinX = minx;
                lastMinY = miny;
                lastMaxX = maxx;
                lastMaxY = maxy;
                minx /= width;
                maxx /= width;
                miny /= height;
                maxy /= height;
                uvFloatArray[0] = minx;
                uvFloatArray[1] = maxy;
                uvFloatArray[2] = minx;
                uvFloatArray[3] = miny;
                uvFloatArray[4] = maxx;
                uvFloatArray[5] = maxy;
                uvFloatArray[6] = maxx;
                uvFloatArray[7] = miny;
                gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, uvFloatArray, gl.DYNAMIC_DRAW);
            }

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        };

        console.log("GL Canvas set up");
    }

    return {
        Canvas: Canvas,
        GlCanvas: GlCanvas,
        bestCanvas: function (canvas) {
            try {
                return new GlCanvas(canvas);
            } catch (e) {
                console.log("Unable to use OpenGL: " + e);
            }
            return new Canvas(canvas);
        }
    };
});
