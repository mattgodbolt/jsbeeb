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
 * Everything except create/delete is a no-op, but the names have to be present:
 * `makeDebugContext` wraps the context by enumerating it.
 */
function recordingGl() {
    const live = new Set();
    let nextId = 0;
    const gl = { live };

    // Constants: any stable value will do, since we only pass them back in.
    for (const [index, name] of (
        "TEXTURE_2D ARRAY_BUFFER RGBA UNSIGNED_BYTE FLOAT STATIC_DRAW DYNAMIC_DRAW " +
        "CLAMP_TO_EDGE LINEAR NEAREST TEXTURE_WRAP_S TEXTURE_WRAP_T TEXTURE_MAG_FILTER TEXTURE_MIN_FILTER " +
        "UNPACK_ALIGNMENT VERTEX_SHADER FRAGMENT_SHADER COMPILE_STATUS LINK_STATUS TEXTURE0 TEXTURE1 " +
        "TRIANGLE_STRIP HIGH_FLOAT"
    )
        .split(" ")
        .entries())
        gl[name] = index + 1;
    gl.NO_ERROR = 0;

    for (const kind of ["Texture", "Buffer", "Program", "Shader"]) {
        gl[`create${kind}`] = () => {
            const object = { kind, id: nextId++ };
            live.add(object);
            return object;
        };
        gl[`delete${kind}`] = (object) => {
            if (object === null) return; // WebGL ignores this; a double delete would not be.
            expect(live.has(object), `deleted a ${object.kind} that was not live`).toBe(true);
            live.delete(object);
        };
    }

    // Queries the canvas and filters make on the way up.
    Object.assign(gl, {
        getError: () => 0,
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getShaderInfoLog: () => "",
        getProgramInfoLog: () => "",
        getAttribLocation: () => 0,
        getUniformLocation: () => ({}),
        getShaderPrecisionFormat: () => ({ precision: 23 }),
    });

    for (const name of (
        "shaderSource compileShader attachShader linkProgram useProgram depthMask viewport " +
        "bindTexture bindBuffer bufferData texImage2D texSubImage2D texParameteri pixelStorei activeTexture " +
        "enableVertexAttribArray vertexAttribPointer drawArrays uniform1i uniform1f uniform2f"
    ).split(" "))
        gl[name] = () => {};

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
        expect([...gl.live].filter((object) => object.kind === "Shader")).toEqual([]);
    });

    it.each(filters)("releases its shaders when one will not compile (%s)", (_name, filterClass) => {
        const gl = recordingGl();
        let compiles = 0;
        gl.getShaderParameter = () => ++compiles < 2;

        expect(() => new filterClass(gl)).toThrow(/compil/i);
        expect([...gl.live]).toEqual([]);
    });

    it.each(filters)("releases its program and shaders when linking fails (%s)", (_name, filterClass) => {
        const gl = recordingGl();
        gl.getProgramParameter = () => false;

        expect(() => new filterClass(gl)).toThrow(/Failed to link/);
        expect([...gl.live]).toEqual([]);
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
