
	// Screen shader emissive section (inserted part way through main() - replaces the threejs emissivemap_fragment)
	// https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/emissivemap_fragment.glsl.js  

	vec4 emissiveColor = vec4(0);

	// place overall position of screen on glass
	vec2 uv = vUv;
	uv -= vec2( 0.02, 0.27 ); // hardcoded for glass uvs on current model
	uv.y *= 1.22f; // hardcoded for glass uvs on current model

	// select active region of jsbeeb canvas texture
	vec2 screenUV = uv;
	screenUV += vec2(0.225, 0.73); // hardcoded zoom for screen content - was in texture offset
	screenUV *= vec2(0.7, 0.55); // hardcoded zoom for screen content - was in texture repeat

	// small blur of source texture
	float total = 0.0;
	emissiveColor.rgb += texture2D( emissiveMap, screenUV ).rgb; total += 1.0;
	// horizontal
	emissiveColor.rgb += texture2D( emissiveMap, screenUV + vec2( 0.0012, 0) ).rgb * 0.1;  total += 0.1;
	emissiveColor.rgb += texture2D( emissiveMap, screenUV + vec2(-0.0012, 0) ).rgb * 0.1;  total += 0.1;
	// vertical
	//emissiveColor.rgb += texture2D( emissiveMap, screenUV + vec2( 0.0, 0.0005) ).rgb * 0.05; total += 0.05;
	//emissiveColor.rgb += texture2D( emissiveMap, screenUV + vec2( 0.0, -0.0005) ).rgb * 0.05;  total += 0.05;
	emissiveColor.rgb = emissiveColor.rgb / total;

	// ambient emissive with mask
	emissiveColor += vec4(0.03f);


	float scanlineIntensity = 0.4;
	float scanlineT = uv.y * 1024.0 * 3.14159;
	float scanelineDelta = length( vec2(dFdx(scanlineT), dFdy(scanlineT)) );
	// Integral of sin( scanlineT +- scanelineDelta * 0.5 ) / scanelineDelta
	float scanlineA = -cos( scanlineT - scanelineDelta * 0.5);
	float scanlineB = -cos( scanlineT + scanelineDelta * 0.5);
	float scanlineVal = (scanlineB - scanlineA) / scanelineDelta;
	emissiveColor.rgb = emissiveColor.rgb * ((scanlineVal * 0.5 + 0.5) * scanlineIntensity + (1.0 - scanlineIntensity));


	// apply mask texture
	vec4 maskSample = texture2D(maskTexture, uv * vec2(7,8) * 16.0);
	maskSample = maskSample * 3.0f;
	emissiveColor.rgb *= maskSample.rgb;

	// ambient emissive without mask
	emissiveColor += vec4(0.02f);

	// dark border around edge of glass
	float r=0.08;
	float feather=20.0;
	vec2 cuv = clamp(uv, vec2(r), vec2(1.0-r));
	float borderFactor = clamp( (length(cuv - uv)/r-1.0) * feather, 0.0, 1.0 );
	emissiveColor.rgb = mix(emissiveColor.rgb, vec3(0), borderFactor);
	diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.5, borderFactor);

	totalEmissiveRadiance *= emissiveColor.rgb;
