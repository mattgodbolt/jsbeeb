attribute vec2 pos;
attribute vec2 uvIn;
varying vec2 vTexCoord;

void main() {
    vTexCoord = uvIn;
    gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
