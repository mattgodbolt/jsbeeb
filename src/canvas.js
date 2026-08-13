"use strict";
import webglDebug from "./lib/webgl-debug.js";
import { PALCompositeFilter } from "./video-filters/pal-composite.js";
import { PassthroughFilter } from "./video-filters/passthrough-filter.js";
import { XbrFilter } from "./video-filters/xbr-filter.js";

const DISPLAY_MODE_FILTERS = {
    pal: PALCompositeFilter,
    rgb: PassthroughFilter,
    xbr: XbrFilter,
};

export function getFilterForMode(mode) {
    return DISPLAY_MODE_FILTERS[mode] || DISPLAY_MODE_FILTERS.rgb;
}

export class Canvas {
    /** The 2D canvas draws the framebuffer as-is, which is what this filter is. */
    get filterClass() {
        return PassthroughFilter;
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
        this.canvas = canvas;

        this.fb32 = new Uint32Array(this.imageData.data.buffer);
    }

    /** Nothing to release: the 2D context owns no objects of ours. */
    dispose() {}

    setFilter(filterClass) {
        if (filterClass !== PassthroughFilter)
            throw new Error(`${filterClass.getDisplayConfig().name} needs WebGL, which is not in use here`);
    }

    paint(minx, miny, maxx, maxy, _frame) {
        const width = maxx - minx;
        const height = maxy - miny;
        this.backCtx.putImageData(this.imageData, 0, 0, minx, miny, width, height);
        // Read the size each time: it can change when the window is resized.
        this.ctx.drawImage(this.backBuffer, minx, miny, width, height, 0, 0, this.canvas.width, this.canvas.height);
    }
}

const width = 1024;
const height = 1024;
export class GlCanvas {
    /** The filter actually built, which may not be the one that was asked for. */
    get filterClass() {
        return this.filter.constructor;
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

        this.fb8 = new Uint8Array(width * height * 4);
        this.fb32 = new Uint32Array(this.fb8.buffer);
        this.texture = checkedGl.createTexture();
        checkedGl.activeTexture(checkedGl.TEXTURE0);
        checkedGl.bindTexture(checkedGl.TEXTURE_2D, this.texture);
        checkedGl.pixelStorei(checkedGl.UNPACK_ALIGNMENT, 4);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_S, checkedGl.CLAMP_TO_EDGE);
        checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_T, checkedGl.CLAMP_TO_EDGE);
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

        this.vertexPositionBuffer = checkedGl.createBuffer();
        checkedGl.bindBuffer(checkedGl.ARRAY_BUFFER, this.vertexPositionBuffer);
        checkedGl.bufferData(checkedGl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), checkedGl.STATIC_DRAW);
        this.uvBuffer = checkedGl.createBuffer();

        this.checkedGl = checkedGl;
        this.filter = null;
        this.attribLocations = [];
        this.viewportWidth = this.viewportHeight = 0;
        this.uvFloatArray = new Float32Array(8);
        this.lastExtent = {};

        try {
            this.setFilter(filterClass);
        } catch (e) {
            this.dispose();
            throw e;
        }

        console.log("GL Canvas set up");
    }

    /**
     * Draw with `filterClass` from here on, keeping the framebuffer texture and
     * the vertex buffers: only the program, the texture sampling mode and the
     * attribute locations differ between filters.
     *
     * The new filter is built before the old one is disposed, so a filter that
     * will not build leaves the canvas drawing as it was.
     */
    setFilter(filterClass) {
        const gl = this.checkedGl;
        const filter = new filterClass(gl);
        this.filter?.dispose();
        this.filter = filter;
        gl.useProgram(filter.program);

        // Filters that pick their own samples want the texels they asked for,
        // not a hardware blend of the ones either side.
        const sampling = filterClass.getDisplayConfig().nearestSampling ? gl.NEAREST : gl.LINEAR;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling);

        const bindAttribute = (name, buffer) => {
            const location = gl.getAttribLocation(filter.program, name);
            gl.enableVertexAttribArray(location);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
            return location;
        };
        for (const location of this.attribLocations) gl.disableVertexAttribArray(location);
        this.attribLocations = [bindAttribute("pos", this.vertexPositionBuffer), bindAttribute("uvIn", this.uvBuffer)];
    }

    /**
     * Release the GL objects this canvas owns. Nothing else will: a canvas
     * element hands out one WebGL context for its lifetime, so anything created
     * through that context stays resident however many wrappers come and go.
     */
    dispose() {
        const gl = this.checkedGl;
        this.filter?.dispose();
        this.filter = null;
        gl.deleteTexture(this.texture);
        gl.deleteBuffer(this.vertexPositionBuffer);
        gl.deleteBuffer(this.uvBuffer);
        this.texture = this.vertexPositionBuffer = this.uvBuffer = null;
    }

    paint(minx, miny, maxx, maxy, frame) {
        const gl = this.gl;
        // The drawing buffer can be resized under us — modes that scale to the
        // display do it on every window resize — and the viewport does not
        // follow it.
        if (gl.drawingBufferWidth !== this.viewportWidth || gl.drawingBufferHeight !== this.viewportHeight) {
            this.viewportWidth = gl.drawingBufferWidth;
            this.viewportHeight = gl.drawingBufferHeight;
            gl.viewport(0, 0, this.viewportWidth, this.viewportHeight);
        }
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

        this.filter.setUniforms({
            width,
            height,
            frameCount: frame.frameCount,
            lineGrid: frame.lineGrid,
            // How much of the framebuffer each output pixel covers, which sets
            // how wide an edge-smoothing ramp should be. `extent` holds texel
            // counts; the scaling into texture coordinates above applies only
            // to the local copies that go into the UV buffer.
            texelsPerOutputPixel: (extent.maxx - extent.minx) / gl.drawingBufferWidth,
        });

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}

function fellBackBecause(canvas, reason) {
    canvas.fallbackReason = reason;
    return canvas;
}

/**
 * Draw with `filterClass`, or with the unfiltered display if it will not build,
 * in which case `fallbackReason` says why.
 */
export function useBestFilter(canvas, filterClass) {
    let reason;
    try {
        canvas.setFilter(filterClass);
        return fellBackBecause(canvas, undefined);
    } catch (e) {
        console.log(`Unable to use ${filterClass.getDisplayConfig().name}: ${e}`);
        if (filterClass === PassthroughFilter) throw e;
        reason = e?.message ?? e;
    }
    canvas.setFilter(PassthroughFilter);
    return fellBackBecause(canvas, reason);
}

export function bestCanvas(canvas, filterClass) {
    let reason;
    try {
        return new GlCanvas(canvas, filterClass);
    } catch (e) {
        // Either WebGL is unavailable or this particular filter declined it.
        reason = e?.message ?? e;
        console.log(`Unable to use ${filterClass.getDisplayConfig().name} with WebGL: ${e}`);
    }

    // A canvas that has handed out a WebGL context can never hand out a 2D one,
    // so if the failure came from the filter rather than from WebGL itself, the
    // 2D fallback below would throw and take the emulator with it.
    if (filterClass !== PassthroughFilter) {
        try {
            return fellBackBecause(new GlCanvas(canvas, PassthroughFilter), reason);
        } catch (e) {
            console.log("Unable to fall back to the passthrough filter: " + e);
        }
    }

    return fellBackBecause(new Canvas(canvas), reason);
}
