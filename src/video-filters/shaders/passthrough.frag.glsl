precision mediump float;
uniform sampler2D tex;
varying vec2 uv;
void main() {
    gl_FragColor = texture2D(tex, uv).rgba;
}
