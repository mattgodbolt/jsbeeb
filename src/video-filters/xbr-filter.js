"use strict";

// The xBR-lv2 display mode. See shaders/xbr.frag.glsl for the algorithm and
// xbr.js for the JavaScript reference implementation it mirrors.

import VERT_SHADER from "./shaders/xbr.vert.glsl?raw";
import FRAG_SHADER from "./shaders/xbr.frag.glsl?raw";
import { compileProgram } from "./shader-program.js";
import { LineGridRows } from "./pixel-grid.js";

export class XbrFilter {
    static requiresGl() {
        return true;
    }

    static getDisplayConfig() {
        return {
            name: "Smoothed (xBR)",
            image: "images/cub-monitor.png",
            imageAlt: "A fake CUB computer monitor",
            imageWidth: 896,
            imageHeight: 648,
            canvasLeft: 0,
            canvasTop: 8,
            visibleWidth: 896,
            visibleHeight: 600,
            canvasWidth: 896,
            canvasHeight: 600,
            // Reconstructed detail needs somewhere to go, so this mode will
            // draw into up to twice the usual canvas — but only as far as the
            // display can actually show. Rendering 1792x1200 into a window
            // showing 900 pixels costs four times the fragments for nothing,
            // and this shader is expensive per fragment.
            maxCanvasScale: 2,
            // The shader picks its own samples on the logical pixel grid, so
            // hardware interpolation would only blur what it reads. It is also
            // what makes the shader's early return legal: with no LOD to
            // choose, its texture lookups need no implicit derivatives. See
            // the note beside that return in xbr.frag.glsl before changing it.
            nearestSampling: true,
        };
    }

    constructor(gl) {
        this.gl = gl;

        // The shader floors framebuffer coordinates that run to 1024 to find
        // the pixel grid. mediump cannot resolve one texel from the next up
        // there, so the grid would land on the wrong texel and the picture
        // would come apart. Better to fall back to an unfiltered display than
        // to render a broken one.
        const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        if (!highp || highp.precision === 0)
            throw new Error("xBR needs high fragment shader precision, which this device does not offer");

        this.program = compileProgram(gl, VERT_SHADER, FRAG_SHADER, "xBR");
        this.locations = {
            tex: gl.getUniformLocation(this.program, "tex"),
            lineGrid: gl.getUniformLocation(this.program, "lineGrid"),
            textureSize: gl.getUniformLocation(this.program, "uTextureSize"),
            texelSize: gl.getUniformLocation(this.program, "uTexelSize"),
            texelsPerOutputPixel: gl.getUniformLocation(this.program, "uTexelsPerOutputPixel"),
        };

        // A one-pixel-wide column holding the logical pixel size of each
        // framebuffer row, uploaded afresh each frame.
        this.lineGridTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lineGridTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.activeTexture(gl.TEXTURE0);

        this.allocated = false;
    }

    /** Release the GL objects this filter owns, the extra texture included. */
    dispose() {
        this.gl.deleteProgram(this.program);
        this.gl.deleteTexture(this.lineGridTexture);
        this.program = this.lineGridTexture = null;
    }

    setUniforms(params) {
        const gl = this.gl;
        const lineGrid = params.lineGrid;
        if (lineGrid.length !== LineGridRows)
            throw new Error(`Line grid is ${lineGrid.length} rows, expected ${LineGridRows}`);
        gl.uniform1i(this.locations.tex, 0);
        gl.uniform1i(this.locations.lineGrid, 1);
        gl.uniform2f(this.locations.textureSize, params.width, params.height);
        gl.uniform2f(this.locations.texelSize, 1.0 / params.width, 1.0 / params.height);
        gl.uniform1f(this.locations.texelsPerOutputPixel, params.texelsPerOutputPixel);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lineGridTexture);
        // A single-byte-per-texel image one pixel wide has a one-byte row
        // stride, which the default four-byte unpack alignment would misread.
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        if (this.allocated) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, LineGridRows, gl.LUMINANCE, gl.UNSIGNED_BYTE, lineGrid);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, LineGridRows, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, lineGrid);
            this.allocated = true;
        }
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        // Leave unit 0 active and the framebuffer bound: the canvas uploads the
        // next frame's pixels through whatever is current.
        gl.activeTexture(gl.TEXTURE0);
    }
}
