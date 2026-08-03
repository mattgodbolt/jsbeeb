"use strict";

/**
 * Compile and link a shader program, throwing with the driver's own message if
 * either step fails. Every display filter needs this and they were each keeping
 * their own copy.
 *
 * @param {WebGLRenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 * @param {string} name used in error messages, e.g. "xBR"
 * @returns {WebGLProgram}
 */
export function compileProgram(gl, vertexSource, fragmentSource, name) {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource, name);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, name);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    // Release our references before checking: the program holds its own, so
    // this frees them on failure and hands ownership over on success. A filter
    // that throws here is retried on the fallback path, so leaking a pair of
    // shaders each time would accumulate.
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Failed to link ${name} shader program: ${info}`);
    }

    return program;
}

function compileShader(gl, type, source, name) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        const typeName = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
        gl.deleteShader(shader);
        throw new Error(`Failed to compile ${name} ${typeName} shader: ${info}`);
    }

    return shader;
}
