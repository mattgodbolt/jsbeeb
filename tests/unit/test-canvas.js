// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { GlCanvas, Canvas, bestCanvas, useBestFilter } from "../../src/web/canvas.js";
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
        "TRIANGLE_STRIP HIGH_FLOAT BLEND CONSTANT_ALPHA ONE FUNC_REVERSE_SUBTRACT MAX_EXT FRAMEBUFFER COLOR_ATTACHMENT0"
    )
        .split(" ")
        .entries())
        gl[name] = index + 1;
    gl.NO_ERROR = 0;

    for (const kind of ["Texture", "Buffer", "Program", "Shader", "Framebuffer"]) {
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
        getExtension: (name) => (name === "EXT_blend_minmax" ? { MAX_EXT: gl.MAX_EXT } : null),
    });

    for (const name of (
        "shaderSource compileShader attachShader linkProgram useProgram depthMask viewport " +
        "bindTexture bindBuffer bufferData texImage2D texSubImage2D texParameteri pixelStorei activeTexture " +
        "enableVertexAttribArray disableVertexAttribArray vertexAttribPointer drawArrays uniform1i uniform1f uniform2f " +
        "enable disable blendEquation blendColor blendFunc bindFramebuffer framebufferTexture2D"
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

    it("does not when turned off, but still keeps the drawing buffer for persistence", () => {
        const element = attributeRecordingElement(recordingGl());

        new GlCanvas(element, PassthroughFilter, false);

        expect(element.asked[0].desynchronized).toBe(false);
        expect(element.asked[0].preserveDrawingBuffer).toBe(true);
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

describe("phosphor persistence", () => {
    const frame = { lineGrid: new Uint8Array(0), lineBaseEven: 0, lineBaseOdd: 0, phaseBaseEven: 0, phaseBaseOdd: 0 };

    it("scales the old picture down by the persistence, keeps the brighter of it and the frame, then shows it", () => {
        const gl = recordingGl();
        const calls = [];
        for (const name of ["enable", "disable", "blendEquation", "blendColor", "blendFunc", "drawArrays"])
            gl[name] = (...args) => calls.push([name, ...args]);
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);

        canvas.setPersistence(0.6);
        expect(calls).toEqual([]);
        canvas.paint(0, 0, 1024, 625, frame);
        expect(calls).toEqual([
            ["enable", gl.BLEND],
            ["blendEquation", gl.FUNC_REVERSE_SUBTRACT],
            ["blendFunc", gl.ONE, gl.CONSTANT_ALPHA],
            ["blendColor", 0, 0, 0, 0.6],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
            ["enable", gl.BLEND],
            ["blendEquation", gl.MAX_EXT],
            ["blendFunc", gl.ONE, gl.ONE],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
            ["disable", gl.BLEND],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
        ]);
        calls.length = 0;
        canvas.setPersistence(0);
        canvas.paint(0, 0, 1024, 625, frame);
        expect(calls).toEqual([
            ["disable", gl.BLEND],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
        ]);
    });

    it("decays and blends off screen, and puts the finished picture on the screen in one draw", () => {
        const gl = recordingGl();
        const calls = [];
        for (const name of ["bindFramebuffer", "drawArrays"]) gl[name] = (...args) => calls.push([name, ...args]);
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        canvas.setPersistence(0.6);
        calls.length = 0;
        canvas.paint(0, 0, 1024, 625, frame);
        expect(calls).toEqual([
            ["bindFramebuffer", gl.FRAMEBUFFER, canvas.phosphorFramebuffer],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
            ["bindFramebuffer", gl.FRAMEBUFFER, null],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
        ]);
    });

    it("sizes the phosphor to the drawing buffer, again when that changes", () => {
        const gl = recordingGl();
        const sizes = [];
        gl.texImage2D = (target, level, format, width, height) => sizes.push([width, height]);
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        canvas.setPersistence(0.6);
        sizes.length = 0;
        gl.drawingBufferWidth = 896;
        gl.drawingBufferHeight = 600;
        canvas.paint(0, 0, 1024, 625, frame);
        canvas.paint(0, 0, 1024, 625, frame);
        expect(sizes).toEqual([[896, 600]]);
        gl.drawingBufferWidth = 1792;
        gl.drawingBufferHeight = 1200;
        canvas.paint(0, 0, 1024, 625, frame);
        expect(sizes).toEqual([
            [896, 600],
            [1792, 1200],
        ]);
    });

    it("decays over every field since the frame last shown, and not at all for the same frame again", () => {
        const gl = recordingGl();
        const calls = [];
        for (const name of ["blendColor", "drawArrays"]) gl[name] = (...args) => calls.push([name, ...args]);
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        canvas.setPersistence(0.5);
        calls.length = 0;
        canvas.paint(0, 0, 1024, 625, { ...frame, fields: 3 });
        expect(calls[0]).toEqual(["blendColor", 0, 0, 0, 0.125]);
        calls.length = 0;
        canvas.paint(0, 0, 1024, 625, { ...frame, fields: 0 });
        expect(calls).toEqual([
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
        ]);
    });

    it("shows each frame plain when the driver cannot keep the brighter of two colours", () => {
        const gl = recordingGl();
        gl.getExtension = () => null;
        const calls = [];
        for (const name of ["enable", "disable", "drawArrays"]) gl[name] = (...args) => calls.push([name, ...args]);
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        canvas.setPersistence(0.6);
        canvas.paint(0, 0, 1024, 625, frame);
        expect(calls).toEqual([
            ["disable", gl.BLEND],
            ["drawArrays", gl.TRIANGLE_STRIP, 0, 4],
        ]);
    });

    it("draws the frame with the filter's program between the decay and the copy, and leaves it current", () => {
        const gl = recordingGl();
        const programs = [];
        gl.useProgram = (program) => programs.push(program);
        const canvas = new GlCanvas(fakeCanvasElement(gl), PassthroughFilter);
        canvas.setPersistence(0.6);
        programs.length = 0;
        canvas.paint(0, 0, 1024, 625, frame);
        expect(programs).toEqual([
            canvas.decayProgram,
            canvas.filter.program,
            canvas.copyProgram,
            canvas.filter.program,
        ]);
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
    function fake2dContext() {
        return {
            globalAlpha: 1,
            fillStyle: "",
            fillRect: () => {},
            createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
            putImageData: () => {},
            drawImage: vi.fn(),
            getContextAttributes: () => ({}),
        };
    }

    it("washes the old picture down by the decay and keeps the brighter of it and the frame off screen, then shows it", () => {
        const calls = [];
        const recording = (name) => {
            const ctx = fake2dContext();
            ctx.fillRect = (...args) =>
                calls.push([name, "fillRect", ctx.globalCompositeOperation, ctx.globalAlpha, ...args]);
            ctx.drawImage = (source) =>
                calls.push([name, "drawImage", ctx.globalCompositeOperation, ctx.globalAlpha, source]);
            return ctx;
        };
        const screen = recording("screen");
        const backBuffer = { getContext: () => fake2dContext() };
        const phosphor = { width: 0, height: 0, getContext: () => recording("phosphor") };
        const createElement = vi
            .spyOn(document, "createElement")
            .mockReturnValueOnce(backBuffer)
            .mockReturnValueOnce(phosphor);
        try {
            const canvas = new Canvas({
                width: 896,
                height: 600,
                getContext: (kind) => (kind === "2d" ? screen : null),
            });
            calls.length = 0;
            canvas.setPersistence(0.6);
            canvas.paint(0, 0, 1024, 625, {});
            expect(calls).toEqual([
                ["phosphor", "fillRect", "source-over", expect.closeTo(0.4, 5), 0, 0, 896, 600],
                ["phosphor", "drawImage", "lighten", 1, backBuffer],
                ["screen", "drawImage", "source-over", 1, phosphor],
            ]);
            expect([phosphor.width, phosphor.height]).toEqual([896, 600]);
            calls.length = 0;
            canvas.paint(0, 0, 1024, 625, { fields: 2 });
            expect(calls[0]).toEqual(["phosphor", "fillRect", "source-over", expect.closeTo(0.64, 5), 0, 0, 896, 600]);
            calls.length = 0;
            canvas.setPersistence(0);
            canvas.paint(0, 0, 1024, 625, {});
            expect(calls).toEqual([["screen", "drawImage", "source-over", 1, backBuffer]]);
        } finally {
            createElement.mockRestore();
        }
    });

    it("can be disposed even though it owns no GL objects", () => {
        // Callers should not have to know which sort of canvas they have.
        const backing = { width: 1024, height: 625, getContext: () => null };
        expect(() => new Canvas(backing)).toThrow(/2D context/);
        expect(Canvas.prototype.dispose).toBeTypeOf("function");
        expect(() => Canvas.prototype.dispose.call({})).not.toThrow();
    });
});
