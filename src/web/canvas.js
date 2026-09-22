import webglDebug from "../lib/webgl-debug.js";
import { PALCompositeFilter } from "../video-filters/pal-composite.js";
import { PassthroughFilter } from "../video-filters/passthrough-filter.js";
import { XbrFilter } from "../video-filters/xbr-filter.js";
import { compileProgram } from "../video-filters/shader-program.js";

// The phosphor decay is a quad blended so as to scale the old picture down and
// take one level off it; the frame is then drawn over it keeping whichever is
// brighter. The level off is what lets a dim trail reach black: scaled alone,
// an eight-bit value rounds back to itself once it is small enough (at the
// slider's top anything up to a twentieth of full brightness would stay).
const DecayVertexShader = `attribute vec2 pos;
void main() {
    gl_Position = vec4(2.0 * pos - 1.0, 0.0, 1.0);
}`;
const DecayFragmentShader = `precision mediump float;
void main() {
    gl_FragColor = vec4(vec3(1.0 / 255.0), 1.0);
}`;

// The decayed picture lives in a texture of its own and reaches the screen in one draw, so the
// screen never shows it part way through: a low-latency canvas can be the buffer on the glass.
const CopyVertexShader = `attribute vec2 pos;
varying vec2 vTexCoord;
void main() {
    vTexCoord = pos;
    gl_Position = vec4(2.0 * pos - 1.0, 0.0, 1.0);
}`;
const CopyFragmentShader = `precision mediump float;
uniform sampler2D uPhosphor;
varying vec2 vTexCoord;
void main() {
    gl_FragColor = texture2D(uPhosphor, vTexCoord);
}`;
const PhosphorTextureUnit = 1;

const DISPLAY_MODE_FILTERS = {
    pal: PALCompositeFilter,
    rgb: PassthroughFilter,
    xbr: XbrFilter,
};

export function getFilterForMode(mode) {
    return DISPLAY_MODE_FILTERS[mode] || DISPLAY_MODE_FILTERS.rgb;
}

// Persistence is set as an afterglow time, the time constant of the fade in
// milliseconds, which is what the eye judges; the canvases take the share of
// the previous field's glow left after one field of the machine's own length.
// A phosphor lights fully when the beam hits it and decays from there, so the
// old picture is scaled down by that share and each new field drawn whole over
// it, whichever is brighter showing; averaging the two would dim anything that
// moves.
export const MaxPersistenceMs = 500;

export function persistenceFromMs(afterglowMs, fieldMs) {
    return afterglowMs > 0 ? Math.exp(-fieldMs / afterglowMs) : 0;
}

/** The display modes that simulate phosphor persistence, with the setting that holds each one's afterglow time. */
export function persistenceSettings() {
    return Object.entries(DISPLAY_MODE_FILTERS).flatMap(([mode, filterClass]) => {
        const persistence = filterClass.getDisplayConfig().persistence;
        return persistence ? [{ mode, ...persistence }] : [];
    });
}

// The hint asks the browser to skip the renderer compositor queue and hand the buffer straight to
// the display controller, saving a frame or so of output latency. It is only a hint, so read back
// what we actually got.
// https://developer.chrome.com/blog/desynchronized
function reportDesynchronized(ctx, asked) {
    // A lost context returns null here rather than an attributes object.
    const honoured = ctx.getContextAttributes?.()?.desynchronized ?? false;
    if (!asked) console.log("Low latency canvas turned off");
    else console.log(`Low latency canvas ${honoured ? "in use" : "not available"}`);
}

export class Canvas {
    /** The 2D canvas draws the framebuffer as-is, which is what this filter is. */
    get filterClass() {
        return PassthroughFilter;
    }

    constructor(canvas, lowLatency = true) {
        this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: lowLatency });
        if (this.ctx === null) throw new Error("Unable to get a 2D context");
        reportDesynchronized(this.ctx, lowLatency);
        this.ctx.fillStyle = "black";
        this.ctx.fillRect(0, 0, 1024, 625);
        this.backBuffer = window.document.createElement("canvas");
        this.backBuffer.width = 1024;
        this.backBuffer.height = 625;
        this.backCtx = this.backBuffer.getContext("2d", { alpha: false });
        this.imageData = this.backCtx.createImageData(this.backBuffer.width, this.backBuffer.height);
        this.phosphor = window.document.createElement("canvas");
        this.phosphorCtx = this.phosphor.getContext("2d", { alpha: false });
        this.canvas = canvas;
        this.persistence = 0;

        this.fb32 = new Uint32Array(this.imageData.data.buffer);
    }

    /** Nothing to release: the 2D context owns no objects of ours. */
    dispose() {}

    get canPersist() {
        return true;
    }

    /** How much of the previous frame each new one is blended over, 0 for none. */
    setPersistence(persistence) {
        // As GlCanvas.setPersistence: what the phosphor held with none on is stale.
        if (this.persistence <= 0 && persistence > 0) this.phosphor.width = 0;
        this.persistence = persistence;
    }

    setFilter(filterClass) {
        if (filterClass !== PassthroughFilter)
            throw new Error(`${filterClass.getDisplayConfig().name} needs WebGL, which is not in use here`);
    }

    paint(minx, miny, maxx, maxy, frame) {
        const width = maxx - minx;
        const height = maxy - miny;
        this.backCtx.putImageData(this.imageData, 0, 0, minx, miny, width, height);
        const { width: screenWidth, height: screenHeight } = this.canvas;
        if (this.persistence <= 0) {
            this.ctx.globalCompositeOperation = "source-over";
            this.ctx.globalAlpha = 1;
            this.ctx.drawImage(this.backBuffer, minx, miny, width, height, 0, 0, screenWidth, screenHeight);
            return;
        }
        // The decay is a black wash over the old picture; "lighten" then keeps
        // the brighter of that and the new frame, per channel. The wash rounds a
        // value of a few levels back to itself, so a trail here ends a shade
        // above black; the 2D canvas has no subtract that would not also
        // flicker black. All of it happens off screen, which is then shown whole.
        if (this.phosphor.width !== screenWidth || this.phosphor.height !== screenHeight) {
            this.phosphor.width = screenWidth;
            this.phosphor.height = screenHeight;
        }
        const ctx = this.phosphorCtx;
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1 - this.persistence ** (frame.fields ?? 1);
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, screenWidth, screenHeight);
        ctx.globalCompositeOperation = "lighten";
        ctx.globalAlpha = 1;
        ctx.drawImage(this.backBuffer, minx, miny, width, height, 0, 0, screenWidth, screenHeight);
        this.ctx.globalCompositeOperation = "source-over";
        this.ctx.globalAlpha = 1;
        this.ctx.drawImage(this.phosphor, 0, 0);
    }
}

const width = 1024;
const height = 1024;
export class GlCanvas {
    /** The filter actually built, which may not be the one that was asked for. */
    get filterClass() {
        return this.filter.constructor;
    }

    constructor(canvas, filterClass, lowLatency = true) {
        // failIfMajorPerformanceCaveat prevents the use of CPU based WebGL
        // rendering, which is much worse than simply using a 2D canvas for
        // rendering.
        const glAttrs = {
            alpha: false,
            antialias: false,
            depth: false,
            // A desynchronized context flickers without it.
            preserveDrawingBuffer: true,
            stencil: false,
            failIfMajorPerformanceCaveat: true,
            desynchronized: lowLatency,
        };
        const gl = canvas.getContext("webgl", glAttrs) || canvas.getContext("experimental-webgl", glAttrs);
        this.gl = gl;
        if (!gl) {
            throw new Error("Unable to create a GL context");
        }
        reportDesynchronized(gl, lowLatency);
        const checkedGl = webglDebug.makeDebugContext(gl, function (err, funcName) {
            throw new Error("Problem creating GL context: " + webglDebug.glEnumToString(err) + " in " + funcName);
        });

        this.checkedGl = checkedGl;
        this.filter = null;
        this.decayProgram = this.copyProgram = null;
        this.phosphorFramebuffer = this.phosphorTexture = null;
        this.texture = this.vertexPositionBuffer = this.uvBuffer = null;
        this.attribLocations = [];
        this.viewportWidth = this.viewportHeight = 0;
        this.phosphorWidth = this.phosphorHeight = 0;
        this.persistence = 0;
        this.uvFloatArray = new Float32Array(8);
        this.lastExtent = {};

        try {
            checkedGl.depthMask(false);
            // Keeping the brighter of two colours is a blend equation WebGL 1 only
            // has through this extension; without it there is no persistence.
            this.blendMinMax = gl.getExtension("EXT_blend_minmax");
            this.decayProgram = compileProgram(checkedGl, DecayVertexShader, DecayFragmentShader, "phosphor decay");
            this.decayPosLocation = checkedGl.getAttribLocation(this.decayProgram, "pos");
            this.copyProgram = compileProgram(checkedGl, CopyVertexShader, CopyFragmentShader, "phosphor copy");
            this.copyPosLocation = checkedGl.getAttribLocation(this.copyProgram, "pos");
            this.copyPhosphorLocation = checkedGl.getUniformLocation(this.copyProgram, "uPhosphor");
            this.phosphorTexture = checkedGl.createTexture();
            checkedGl.activeTexture(checkedGl.TEXTURE0 + PhosphorTextureUnit);
            checkedGl.bindTexture(checkedGl.TEXTURE_2D, this.phosphorTexture);
            checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_S, checkedGl.CLAMP_TO_EDGE);
            checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_WRAP_T, checkedGl.CLAMP_TO_EDGE);
            // Copied at one to one, where linear sampling reads each texel exactly and turns a
            // rounding error at an edge into a blend rather than a skipped row.
            checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_MAG_FILTER, checkedGl.LINEAR);
            checkedGl.texParameteri(checkedGl.TEXTURE_2D, checkedGl.TEXTURE_MIN_FILTER, checkedGl.LINEAR);
            this.phosphorFramebuffer = checkedGl.createFramebuffer();
            checkedGl.bindFramebuffer(checkedGl.FRAMEBUFFER, this.phosphorFramebuffer);
            checkedGl.framebufferTexture2D(
                checkedGl.FRAMEBUFFER,
                checkedGl.COLOR_ATTACHMENT0,
                checkedGl.TEXTURE_2D,
                this.phosphorTexture,
                0,
            );
            checkedGl.bindFramebuffer(checkedGl.FRAMEBUFFER, null);

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
            checkedGl.bufferData(
                checkedGl.ARRAY_BUFFER,
                new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]),
                checkedGl.STATIC_DRAW,
            );
            this.uvBuffer = checkedGl.createBuffer();

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
        // The filter draws through the plain context every frame, so its setup
        // is checked once here rather than call by call.
        const gl = this.gl;
        const drainErrors = () => {
            let first = gl.NO_ERROR;
            for (let error = gl.getError(); error !== gl.NO_ERROR; error = gl.getError()) {
                if (first === gl.NO_ERROR) first = error;
            }
            return first;
        };
        drainErrors();
        const filter = new filterClass(gl);
        const error = drainErrors();
        if (error !== gl.NO_ERROR) {
            filter.dispose();
            throw new Error(
                `${filterClass.getDisplayConfig().name} failed to set up: ${webglDebug.glEnumToString(error)}`,
            );
        }
        this.filter?.dispose();
        this.filter = filter;

        // Filters that pick their own samples want the texels they asked for,
        // not a hardware blend of the ones either side.
        const sampling = filterClass.getDisplayConfig().nearestSampling ? gl.NEAREST : gl.LINEAR;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling);
        this.useFilterProgram();
    }

    /** Makes the filter's program current with its attributes pointed at our buffers. */
    useFilterProgram() {
        const gl = this.gl;
        const program = this.filter.program;
        gl.useProgram(program);
        const bindAttribute = (name, buffer) => {
            const location = gl.getAttribLocation(program, name);
            gl.enableVertexAttribArray(location);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
            return location;
        };
        for (const location of this.attribLocations) gl.disableVertexAttribArray(location);
        this.attribLocations = [bindAttribute("pos", this.vertexPositionBuffer), bindAttribute("uvIn", this.uvBuffer)];
    }

    /** Makes a full-screen quad program current, with only its position attribute bound. */
    useQuadProgram(program, posLocation) {
        const gl = this.gl;
        gl.useProgram(program);
        for (const location of this.attribLocations) gl.disableVertexAttribArray(location);
        gl.enableVertexAttribArray(posLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexPositionBuffer);
        gl.vertexAttribPointer(posLocation, 2, gl.FLOAT, false, 0, 0);
        this.attribLocations = [posLocation];
    }

    /**
     * Scales the old picture down by the persistence and takes a level off it:
     * the destination factor does the scaling and the quad's colour is what is
     * subtracted.
     */
    decayOldPicture(fields) {
        const gl = this.gl;
        this.useQuadProgram(this.decayProgram, this.decayPosLocation);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
        gl.blendFunc(gl.ONE, gl.CONSTANT_ALPHA);
        gl.blendColor(0, 0, 0, this.persistence ** fields);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** The phosphor texture follows the drawing buffer's size; a resize starts it black. */
    fitPhosphorToViewport() {
        const gl = this.gl;
        if (this.phosphorWidth === this.viewportWidth && this.phosphorHeight === this.viewportHeight) return;
        this.phosphorWidth = this.viewportWidth;
        this.phosphorHeight = this.viewportHeight;
        gl.activeTexture(gl.TEXTURE0 + PhosphorTextureUnit);
        gl.bindTexture(gl.TEXTURE_2D, this.phosphorTexture);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            this.phosphorWidth,
            this.phosphorHeight,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
        );
        gl.activeTexture(gl.TEXTURE0);
    }

    /** Puts the phosphor's picture on the screen as it stands. */
    copyPhosphorToScreen() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.useQuadProgram(this.copyProgram, this.copyPosLocation);
        // A filter may have put its own texture on this unit while it drew.
        gl.activeTexture(gl.TEXTURE0 + PhosphorTextureUnit);
        gl.bindTexture(gl.TEXTURE_2D, this.phosphorTexture);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.copyPhosphorLocation, PhosphorTextureUnit);
        gl.disable(gl.BLEND);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** Whether the driver can keep the brighter of two colours, without which there is no persistence. */
    get canPersist() {
        return !!this.blendMinMax;
    }

    /** How much of the previous frame each new one is blended over, 0 for none. */
    setPersistence(persistence) {
        persistence = this.canPersist ? persistence : 0;
        // With none, frames go straight to the screen and the phosphor keeps a stale picture.
        if (this.persistence <= 0 && persistence > 0) this.phosphorWidth = this.phosphorHeight = 0;
        this.persistence = persistence;
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
        gl.deleteProgram(this.decayProgram);
        gl.deleteProgram(this.copyProgram);
        this.decayProgram = this.copyProgram = null;
        gl.deleteFramebuffer(this.phosphorFramebuffer);
        gl.deleteTexture(this.phosphorTexture);
        this.phosphorFramebuffer = this.phosphorTexture = null;
        gl.deleteTexture(this.texture);
        gl.deleteBuffer(this.vertexPositionBuffer);
        gl.deleteBuffer(this.uvBuffer);
        this.texture = this.vertexPositionBuffer = this.uvBuffer = null;
    }

    paint(minx, miny, maxx, maxy, frame) {
        const gl = this.gl;
        const fields = frame.fields ?? 1;
        // The drawing buffer can be resized under us — modes that scale to the
        // display do it on every window resize — and the viewport does not
        // follow it.
        if (gl.drawingBufferWidth !== this.viewportWidth || gl.drawingBufferHeight !== this.viewportHeight) {
            this.viewportWidth = gl.drawingBufferWidth;
            this.viewportHeight = gl.drawingBufferHeight;
            gl.viewport(0, 0, this.viewportWidth, this.viewportHeight);
        }
        const persisting = this.persistence > 0;
        if (persisting) {
            this.fitPhosphorToViewport();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.phosphorFramebuffer);
            if (fields > 0) this.decayOldPicture(fields);
            this.useFilterProgram();
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
            lineBaseEven: frame.lineBaseEven,
            lineBaseOdd: frame.lineBaseOdd,
            phaseBaseEven: frame.phaseBaseEven,
            phaseBaseOdd: frame.phaseBaseOdd,
            lineGrid: frame.lineGrid,
            // In texels; the scaling into texture coordinates above applies only
            // to the local copies that go into the UV buffer.
            extent,
            // How much of the framebuffer each output pixel covers, which sets
            // how wide an edge-smoothing ramp should be.
            texelsPerOutputPixel: (extent.maxx - extent.minx) / gl.drawingBufferWidth,
        });

        if (!persisting) {
            gl.disable(gl.BLEND);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return;
        }
        // The frame keeps the brighter of itself and what is left of the old picture, which
        // is a blend equation the factors do not apply to.
        gl.enable(gl.BLEND);
        gl.blendEquation(this.blendMinMax.MAX_EXT);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.copyPhosphorToScreen();
        this.useFilterProgram();
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

export function bestCanvas(canvas, filterClass, lowLatency = true) {
    let reason;
    try {
        return new GlCanvas(canvas, filterClass, lowLatency);
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
            return fellBackBecause(new GlCanvas(canvas, PassthroughFilter, lowLatency), reason);
        } catch (e) {
            console.log("Unable to fall back to the passthrough filter: " + e);
        }
    }

    return fellBackBecause(new Canvas(canvas, lowLatency), reason);
}
