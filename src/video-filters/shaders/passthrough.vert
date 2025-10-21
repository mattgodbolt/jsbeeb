// Simple passthrough vertex shader for PAL filter
// Maps screen quad to texture coordinates

attribute vec2 pos;          // Vertex position (0-1 range)
attribute vec2 uvIn;         // Texture coordinate (0-1 range)

varying vec2 vTexCoord;      // Pass to fragment shader
varying vec2 vPixelCoord;    // Pixel coordinate for scanline calculation

uniform vec2 uResolution;    // Framebuffer resolution (1024, 625)

void main() {
    vTexCoord = uvIn;
    vPixelCoord = uvIn * uResolution;

    // Convert 0-1 to -1 to 1 (clip space)
    gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
