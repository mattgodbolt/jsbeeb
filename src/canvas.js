"use strict";
import webglDebug from "./lib/webgl-debug.js";
import { PALCompositeFilter } from "./video-filters/pal-composite.js";
import { PassthroughFilter } from "./video-filters/passthrough-filter.js";

const DISPLAY_MODE_FILTERS = {
    pal: PALCompositeFilter,
    rgb: PassthroughFilter,
};

export function getFilterForMode(mode) {
    return DISPLAY_MODE_FILTERS[mode] || DISPLAY_MODE_FILTERS.rgb;
}

export class Canvas {
    isWebGl() {
        return false;
    }

    constructor(canvas) {
        this.ctx = canvas.getContext("2d", { alpha: false });
        if (this.ctx === null) throw new Error("Unable to get a 2D context");
        this.ctx.fillStyle = "black";
        this.ctx.fillRect(0, 0, 1024, 625);
        this.backBuffer = window.document.createElement("canvas");
        this.backBuffer.width = 1024;
        this.backBuffer.height = 625;
        this.backCtx = this.backBuffer.getContext("2d", { alpha: false });
        this.imageData = this.backCtx.createImageData(this.backBuffer.width, this.backBuffer.height);
        this.canvasWidth = canvas.width;
        this.canvasHeight = canvas.height;

        this.fb32 = new Uint32Array(this.imageData.data.buffer);
    }
    paint(minx, miny, maxx, maxy, _frameCount) {
        const width = maxx - minx;
        const height = maxy - miny;
        this.backCtx.putImageData(this.imageData, 0, 0, minx, miny, width, height);
        this.ctx.drawImage(this.backBuffer, minx, miny, width, height, 0, 0, this.canvasWidth, this.canvasHeight);
    }
}

const width = 1024;
const height = 1024;
export class GlCanvas {
    isWebGl() {
        return true;
    }

    constructor(canvas, filterClass) {
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

        this.filter = new filterClass(checkedGl);
        const program = this.filter.program;
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

    paint(minx, miny, maxx, maxy, frameCount) {
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

        this.filter.setUniforms({ width, height, frameCount });

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}

export function bestCanvas(canvas, filterClass) {
    try {
        return new GlCanvas(canvas, filterClass);
    } catch (e) {
        console.log("Unable to use OpenGL: " + e);
        if (filterClass.requiresGl()) {
            const config = filterClass.getDisplayConfig();
            console.warn(`${config.name} requires WebGL. Falling back to standard 2D canvas.`);
        }
    }
    return new Canvas(canvas);
}
