import { describe, it, expect } from "vitest";
import { GlCanvas, Canvas, bestCanvas, useBestFilter } from "../../src/canvas.js";
import PAL_FRAG_SHADER from "../../src/video-filters/shaders/pal-composite.frag.glsl?raw";
import { PassthroughFilter } from "../../src/video-filters/passthrough-filter.js";
import { PALCompositeFilter } from "../../src/video-filters/pal-composite.js";
import { XbrFilter } from "../../src/video-filters/xbr-filter.js";

// A canvas element hands out a WebGL context once and returns that same context
// for every later request, so anything created through it stays resident until
// it is deleted, whatever happens to the JS objects holding it. The framebuffer
// texture alone is 1024x1024 RGBA.

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
        "enableVertexAttribArray disableVertexAttribArray vertexAttribPointer drawArrays uniform1i uniform1f uniform2f"
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

/** Make `gl` reject one particular shader, as a device without the features for it would. */
function failToCompile(gl, shaderSource) {
    const sources = new Map();
    gl.shaderSource = (shader, source) => sources.set(shader, source);
    gl.getShaderParameter = (shader) => sources.get(shader) !== shaderSource;
}

describe("GlCanvas", () => {
    const filters = [
        ["passthrough", PassthroughFilter],
        ["PAL composite", PALCompositeFilter],
        // xBR owns a second texture, so it is the one most likely to be missed.
        ["xBR", XbrFilter],
    ];

    it.each(filters)("releases everything it created when disposed (%s)", (_name, filterClass) => {
        const gl = recordingGl();
        const canvas = new GlCanvas(fakeCanvasElement(gl), filterClass);
        expect(gl.live.size).toBeGreaterThan(0);

        canvas.dispose();
        expect([...gl.live]).toEqual([]);
    });

    it.each(filters)("releases what it created when the filter will not build (%s)", (_name, filterClass) => {
        const gl = recordingGl();
        gl.getProgramParameter = () => false;

        expect(() => new GlCanvas(fakeCanvasElement(gl), filterClass)).toThrow(/Failed to link/);
        expect([...gl.live]).toEqual([]);
    });

    it("does not accumulate objects over repeated display mode switches", () => {
        // Filters own different numbers of objects (xBR has a second texture),
        // so the invariant is that returning to a filter returns to its own
        // count, not that every count is the same.
        const gl = recordingGl();
        const element = fakeCanvasElement(gl);

        // What each filter owns when freshly built and alone, so every
        // assertion in the loop below compares against a known number rather
        // than against whatever the first visit happened to produce.
        const expected = new Map();
        for (const [, filterClass] of filters) {
            const only = new GlCanvas(element, filterClass);
            expected.set(filterClass, gl.live.size);
            only.dispose();
        }

        const canvas = new GlCanvas(element, filters[0][1]);
        for (let switches = 1; switches <= 3 * filters.length; ++switches) {
            const [name, filterClass] = filters[switches % filters.length];
            canvas.setFilter(filterClass);
            expect(gl.live.size, `after switching to ${name}`).toBe(expected.get(filterClass));
        }
    });

    it("keeps its framebuffer and vertex buffers when the filter changes", () => {
        const gl = recordingGl();
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        const fb32 = canvas.fb32;
        const kept = [...gl.live].filter((object) => object.kind !== "Program");
        expect(kept.length).toBeGreaterThan(0);

        canvas.setFilter(PALCompositeFilter);

        expect(canvas.filterClass).toBe(PALCompositeFilter);
        expect([...gl.live]).toEqual(expect.arrayContaining(kept));
        expect(canvas.fb32).toBe(fb32);
    });

    it("goes on drawing with the filter it has when a new one will not build", () => {
        const gl = recordingGl();
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        const live = gl.live.size;
        gl.getProgramParameter = () => false;

        expect(() => canvas.setFilter(PALCompositeFilter)).toThrow(/Failed to link/);
        expect(canvas.filterClass).toBe(PassthroughFilter);
        expect(gl.live.size).toBe(live);
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

describe("low latency canvas", () => {
    /** Records the attributes each context was asked for. */
    function attributeRecordingElement(gl) {
        const asked = [];
        return {
            asked,
            width: 896,
            height: 600,
            getContext: (kind, attrs) => {
                asked.push(attrs);
                return kind === "2d" ? null : gl;
            },
        };
    }

    it("asks for a desynchronized context by default", () => {
        const element = attributeRecordingElement(recordingGl());

        new GlCanvas(element, PassthroughFilter);

        expect(element.asked[0].desynchronized).toBe(true);
        expect(element.asked[0].preserveDrawingBuffer).toBe(true);
    });

    it("does not when turned off", () => {
        const element = attributeRecordingElement(recordingGl());

        new GlCanvas(element, PassthroughFilter, false);

        expect(element.asked[0].desynchronized).toBe(false);
        expect(element.asked[0].preserveDrawingBuffer).toBe(false);
    });

    it("survives a context that reports no attributes at all", () => {
        const gl = recordingGl();
        gl.getContextAttributes = () => null;

        expect(() => new GlCanvas(attributeRecordingElement(gl), PassthroughFilter)).not.toThrow();
    });

    it("passes the choice on through bestCanvas", () => {
        const element = attributeRecordingElement(recordingGl());

        bestCanvas(element, PassthroughFilter, false);

        expect(element.asked[0].desynchronized).toBe(false);
    });
});

describe("bestCanvas", () => {
    it("falls back to the passthrough filter when the one asked for will not build", () => {
        // The 2D fallback is unreachable once a WebGL context exists, so a
        // filter that fails to build has to be replaced on the context we have.
        const gl = recordingGl();
        failToCompile(gl, PAL_FRAG_SHADER);

        const canvas = bestCanvas(fakeCanvasElement(gl), PALCompositeFilter);

        expect(canvas.filterClass).toBe(PassthroughFilter);
        expect(canvas.fallbackReason).toMatch(/Failed to compile PAL composite/);
    });
});

describe("useBestFilter", () => {
    it("falls back to the passthrough filter when the one asked for will not build", () => {
        const gl = recordingGl();
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        failToCompile(gl, PAL_FRAG_SHADER);

        useBestFilter(canvas, PALCompositeFilter);

        expect(canvas.filterClass).toBe(PassthroughFilter);
        expect(canvas.fallbackReason).toMatch(/Failed to compile PAL composite/);
    });

    it("forgets a previous fallback once a filter builds", () => {
        const gl = recordingGl();
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        failToCompile(gl, PAL_FRAG_SHADER);
        useBestFilter(canvas, PALCompositeFilter);

        useBestFilter(canvas, XbrFilter);

        expect(canvas.filterClass).toBe(XbrFilter);
        expect(canvas.fallbackReason).toBeUndefined();
    });

    it("leaves a 2D canvas unfiltered, saying why", () => {
        // Not a constructed one: it wants a document to build its back buffer.
        const canvas = Object.create(Canvas.prototype);

        useBestFilter(canvas, PALCompositeFilter);

        expect(canvas.filterClass).toBe(PassthroughFilter);
        expect(canvas.fallbackReason).toMatch(/WebGL/);
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
