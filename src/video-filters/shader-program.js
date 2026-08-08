"use strict";

/**
 * Compile and link a shader program, throwing with the driver's own message if
 * either step fails.
 *
 * @param {WebGLRenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 * @param {string} name used in error messages, e.g. "xBR"
 * @returns {WebGLProgram}
 */
export function compileProgram(gl, vertexSource, fragmentSource, name) {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource, name);
    let fragmentShader = null;
    try {
        fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, name);

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`Failed to link ${name} shader program: ${info}`);
        }

        return program;
    } finally {
        // Once linked the program holds its own reference, so releasing ours here means
        // deleting the program later frees the shaders too. If we never got that far, ours
        // was the only reference and they go now.
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
    }
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
