"use strict";
import webglDebug from "./lib/webgl-debug.js";
import { PALCompositeFilter } from "./video-filters/pal-composite.js";

export class Canvas {
    constructor(canvas) {
        this.ctx = canvas.getContext("2d");
        if (this.ctx === null) throw new Error("Unable to get a 2D context");
        this.ctx.fillStyle = "black";
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
    paint(minx, miny, maxx, maxy) {
        const width = maxx - minx;
        const height = maxy - miny;
        this.backCtx.putImageData(this.imageData, 0, 0, minx, miny, width, height);
        this.ctx.drawImage(this.backBuffer, minx, miny, width, height, 0, 0, this.canvasWidth, this.canvasHeight);
    }
}

const width = 1024;
const height = 1024;
export class GlCanvas {
    constructor(canvas) {
        // failIfMajorPerformanceCaveat prevents the use of CPU based WebGL
        // rendering, which is much worse than simply using a 2D canvas for
        // rendering.
        const glAttrs = {
            alpha: false,
            antialias: false,
            depth: false,
            preserveDrawingBuffer: false,
            stencil: false,
            failIfMajorPerformanceCaveat: true,
        };
        const gl = canvas.getContext("webgl", glAttrs) || canvas.getContext("experimental-webgl", glAttrs);
        this.gl = gl;
        if (!gl) {
            throw new Error("Unable to create a GL context");
        }
        const checkedGl = webglDebug.makeDebugContext(gl, function (err, funcName) {
            throw new Error("Problem creating GL context: " + webglDebug.glEnumToString(err) + " in " + funcName);
        });

        checkedGl.depthMask(false);

        // Create PAL composite filter
        this.palFilter = new PALCompositeFilter(checkedGl);
        const program = this.palFilter.program;
        checkedGl.useProgram(program);

        this.fb8 = new Uint8Array(width * height * 4);
        this.fb32 = new Uint32Array(this.fb8.buffer);
        this.texture = checkedGl.createTexture();
        checkedGl.bindTexture(checkedGl.TEXTURE_2D, this.texture);
        checkedGl.pixelStorei(checkedGl.UNPACK_ALIGNMENT, 4);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_S, checkedGl.CLAMP_TO_EDGE);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_T, checkedGl.CLAMP_TO_EDGE);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_MAG_FILTER, checkedGl.LINEAR);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_MIN_FILTER, checkedGl.LINEAR);
        checkedGl.texImage2D(
            checkedGl.TEXTURE_2D,
            0,
            checkedGl.RGBA,
            width,
            height,
            0,
            checkedGl.RGBA,
            checkedGl.UNSIGNED_BYTE,
            this.fb8,
        );
        checkedGl.bindTexture(checkedGl.TEXTURE_2D, null);

        // Set up PAL filter uniforms
        checkedGl.uniform1i(this.palFilter.locations.uFramebuffer, 0);
        checkedGl.uniform2f(this.palFilter.locations.uResolution, width, height);
        checkedGl.uniform2f(this.palFilter.locations.uTexelSize, 1.0 / width, 1.0 / height);

        const vertexPositionAttrLoc = checkedGl.getAttribLocation(program, "pos");
        checkedGl.enableVertexAttribArray(vertexPositionAttrLoc);
        const vertexPositionBuffer = checkedGl.createBuffer();
        checkedGl.bindBuffer(checkedGl.ARRAY_BUFFER, vertexPositionBuffer);
        checkedGl.bufferData(checkedGl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), checkedGl.STATIC_DRAW);
        checkedGl.vertexAttribPointer(vertexPositionAttrLoc, 2, checkedGl.FLOAT, false, 0, 0);

        const uvAttrLoc = checkedGl.getAttribLocation(program, "uvIn");
        checkedGl.enableVertexAttribArray(uvAttrLoc);
        this.uvBuffer = checkedGl.createBuffer();
        checkedGl.bindBuffer(checkedGl.ARRAY_BUFFER, this.uvBuffer);
        checkedGl.vertexAttribPointer(uvAttrLoc, 2, checkedGl.FLOAT, false, 0, 0);

        checkedGl.activeTexture(gl.TEXTURE0);
        checkedGl.bindTexture(gl.TEXTURE_2D, this.texture);

        this.uvFloatArray = new Float32Array(8);
        this.lastExtent = {};

        console.log("GL Canvas set up");
    }

    paint(minx, miny, maxx, maxy) {
        const gl = this.gl;
        // We can't specify a stride for the source, so have to use the full width.
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            miny,
            width,
            maxy - miny,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            this.fb8.subarray(miny * width * 4, maxy * width * 4),
        );
        const extent = { minx, miny, maxx, maxy };

        if (
            extent.minx !== this.lastExtent.minx ||
            extent.miny !== this.lastExtent.miny ||
            extent.maxx !== this.lastExtent.maxx ||
            extent.maxy !== this.lastExtent.maxy
        ) {
            this.lastExtent = extent;
            minx /= width;
            maxx /= width;
            miny /= height;
            maxy /= height;
            this.uvFloatArray[0] = minx;
            this.uvFloatArray[1] = maxy;
            this.uvFloatArray[2] = minx;
            this.uvFloatArray[3] = miny;
            this.uvFloatArray[4] = maxx;
            this.uvFloatArray[5] = maxy;
            this.uvFloatArray[6] = maxx;
            this.uvFloatArray[7] = miny;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.uvFloatArray, gl.DYNAMIC_DRAW);
        }

        // Set PAL filter uniforms for visible region (need original pixel coords before normalization)
        gl.uniform1f(this.palFilter.locations.uLeftBorder, extent.minx);
        gl.uniform1f(this.palFilter.locations.uActiveWidth, extent.maxx - extent.minx);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}

export function bestCanvas(canvas) {
    try {
        return new GlCanvas(canvas);
    } catch (e) {
        console.log("Unable to use OpenGL: " + e);
    }
    return new Canvas(canvas);
}
