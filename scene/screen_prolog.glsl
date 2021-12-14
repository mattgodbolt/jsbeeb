// Screen shader prolog (inserted just before include <common> )

uniform sampler2D maskTexture;
uniform float time;

uniform float maskIntensity;

uniform vec3 screenColR;
uniform vec3 screenColG;
uniform vec3 screenColB;

float InterferenceHash(float p)
{
    float hashScale = 0.1031;

    vec3 p3  = fract(vec3(p, p, p) * hashScale);
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.x + p3.y) * p3.z);
}


float InterferenceSmoothNoise1D( float x )
{
    float f0 = floor(x);
    float fr = fract(x);

    float h0 = InterferenceHash( f0 );
    float h1 = InterferenceHash( f0 + 1.0 );

    return h1 * fr + h0 * (1.0 - fr);
}


float InterferenceNoise( vec2 uv )
{
    float displayVerticalLines = 1024.0;//483.0;
    float scanLine = floor(uv.y * displayVerticalLines);
    float scanPos = scanLine + uv.x;
    float timeSeed = fract( time * 123.78 );

    return InterferenceSmoothNoise1D( scanPos * 234.5 + timeSeed * 12345.6 );
}
