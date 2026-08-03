import { describe, it, expect } from "vitest";
import { GlCanvas, Canvas } from "../../src/canvas.js";
import { PassthroughFilter } from "../../src/video-filters/passthrough-filter.js";
import { PALCompositeFilter } from "../../src/video-filters/pal-composite.js";

// A canvas element hands out a WebGL context once and returns that same context
// for every later request, so switching display mode builds a new GlCanvas over
// the old one's context. Anything the old one created stays resident until it
// is deleted, and the framebuffer texture alone is 1024x1024 RGBA.

/**
 * A WebGL context that records the objects created and deleted through it.
 * Every object it hands out is a distinct tagged token, so a test can tell not
 * only how many were released but which.
 */
function recordingGl() {
    const live = new Set();
    let nextId = 0;
    const create = (kind) => () => {
        const object = { kind, id: nextId++ };
        live.add(object);
        return object;
    };
    const destroy = () => (object) => {
        // WebGL ignores deleting null; a double delete would be a real bug.
        if (object === null) return;
        expect(live.has(object), `deleted a ${object.kind} that was not live`).toBe(true);
        live.delete(object);
    };
    const gl = {
        live,
        // Enough of the enum for the calls below; the values are arbitrary.
        TEXTURE_2D: 1,
        ARRAY_BUFFER: 2,
        RGBA: 3,
        UNSIGNED_BYTE: 4,
        FLOAT: 5,
        STATIC_DRAW: 6,
        DYNAMIC_DRAW: 7,
        CLAMP_TO_EDGE: 8,
        LINEAR: 9,
        NEAREST: 10,
        TEXTURE_WRAP_S: 11,
        TEXTURE_WRAP_T: 12,
        TEXTURE_MAG_FILTER: 13,
        TEXTURE_MIN_FILTER: 14,
        UNPACK_ALIGNMENT: 15,
        VERTEX_SHADER: 16,
        FRAGMENT_SHADER: 17,
        COMPILE_STATUS: 18,
        LINK_STATUS: 19,
        TEXTURE0: 20,
        TEXTURE1: 21,
        TRIANGLE_STRIP: 22,
        NO_ERROR: 0,
        HIGH_FLOAT: 23,

        createTexture: create("texture"),
        createBuffer: create("buffer"),
        createProgram: create("program"),
        createShader: create("shader"),
        deleteTexture: destroy(),
        deleteBuffer: destroy(),
        deleteProgram: destroy(),
        deleteShader: destroy(),

        // Everything else is a no-op or a fixed answer.
        getError: () => 0,
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getShaderInfoLog: () => "",
        getProgramInfoLog: () => "",
        getAttribLocation: () => 0,
        getUniformLocation: () => ({}),
        getShaderPrecisionFormat: () => ({ precision: 23 }),
        shaderSource: () => {},
        compileShader: () => {},
        attachShader: () => {},
        linkProgram: () => {},
        useProgram: () => {},
        depthMask: () => {},
        viewport: () => {},
        bindTexture: () => {},
        bindBuffer: () => {},
        bufferData: () => {},
        texImage2D: () => {},
        texSubImage2D: () => {},
        texParameteri: () => {},
        pixelStorei: () => {},
        activeTexture: () => {},
        enableVertexAttribArray: () => {},
        vertexAttribPointer: () => {},
        drawArrays: () => {},
        uniform1i: () => {},
        uniform1f: () => {},
        uniform2f: () => {},
    };
    return gl;
}

/** A canvas element that hands out the same context however often it is asked. */
function fakeCanvasElement(gl) {
    return {
        width: 896,
        height: 600,
        getContext: (kind) => (kind === "2d" ? null : gl),
    };
}

describe("GlCanvas", () => {
    const filters = [
        ["passthrough", PassthroughFilter],
        ["PAL composite", PALCompositeFilter],
    ];

    it.each(filters)("releases everything it created when disposed (%s)", (_name, filterClass) => {
        const gl = recordingGl();
        const canvas = new GlCanvas(fakeCanvasElement(gl), filterClass);
        expect(gl.live.size).toBeGreaterThan(0);

        canvas.dispose();
        expect([...gl.live]).toEqual([]);
    });

    it("does not accumulate objects over repeated display mode switches", () => {
        // This is the shape of the leak: swapping modes builds a new canvas over
        // the same context, so without disposal each switch strands a texture,
        // two buffers and a program.
        const gl = recordingGl();
        const element = fakeCanvasElement(gl);

        let canvas = new GlCanvas(element, PassthroughFilter);
        const afterFirst = gl.live.size;

        for (let switches = 0; switches < 5; ++switches) {
            const next = new GlCanvas(element, switches % 2 ? PassthroughFilter : PALCompositeFilter);
            canvas.dispose();
            canvas = next;
            expect(gl.live.size).toBe(afterFirst);
        }
    });

    it("frees its shaders as soon as they are linked", () => {
        // The program keeps them alive; holding a second reference here would
        // mean deleting the program never released them.
        const gl = recordingGl();
        new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        expect([...gl.live].filter((object) => object.kind === "shader")).toEqual([]);
    });
});

describe("Canvas", () => {
    it("can be disposed even though it owns no GL objects", () => {
        // Callers should not have to know which sort of canvas they have.
        const backing = { width: 1024, height: 625, getContext: () => null };
        expect(() => new Canvas(backing)).toThrow(/2D context/);
        expect(Canvas.prototype.dispose).toBeTypeOf("function");
        expect(() => Canvas.prototype.dispose.call({})).not.toThrow();
    });
});
