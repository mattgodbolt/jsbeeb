attribute vec2 pos;
attribute vec2 uvIn;
varying vec2 uv;
void main() {
    uv = uvIn;
    gl_Position = vec4(2.0 * pos - 1.0, 0.0, 1.0);
}
