    // Screen shader epilog (inserted near the end of main)

    totalEmissiveRadiance = totalEmissiveRadiance.r * screenColR + totalEmissiveRadiance.g * screenColG + totalEmissiveRadiance.b * screenColB;

    // Fade emissive based on transmittance from fresnel (as it is behind the glass)
    // we need to do this at this point (later than emissive) in the shader so we have access to the other material variables
    totalEmissiveRadiance *= 1.0 - BRDF_Specular_GGX_Environment( geometry.viewDir, geometry.normal, vec3( DEFAULT_SPECULAR_COEFFICIENT ), material.specularRoughness);

    vec3 rayOrigin = geometry.position;
    // Transform position from view to world
    rayOrigin = ( vec4(rayOrigin - viewMatrix[3].xyz,0) * viewMatrix ).xyz;

    vec3 rayDir = normalize(reflect( -geometry.viewDir, geometry.normal ));
    rayDir = inverseTransformDirection( rayDir, viewMatrix );

    float beebRepeatSpacing = 22.0;
    float beebId = floor( (rayOrigin.x / beebRepeatSpacing) - 0.5 );

    // Add a fake reflection of the Beeb
    float fakeReflectionHeight = -3.5;
    float planeOffset = rayOrigin.y + fakeReflectionHeight;
    if( rayDir.y < 0.0 && planeOffset > 0.0 )
    {
        vec2 uv = rayOrigin.xz + rayDir.xz * (planeOffset) / (-rayDir.y);

        uv.x -= (beebId + 1.0) * beebRepeatSpacing;

        float feather = 1.0;
        vec2 fakeReflectionSize = vec2(9,5);
        feather = min(feather, (fakeReflectionSize.x - abs(uv.x))*2.0);
        feather = min(feather, (fakeReflectionSize.y - abs(uv.y))*2.0);
        feather = clamp( feather, 0.0 , 1.0 );

        reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, vec3(0.015), feather );
    }

    // Add some masking of the reflection from hardcoded self-occlusion of the monitor surround (basically how backwards facing we are)
    float reflectionMask = 1.0;

    reflectionMask = clamp( (rayDir.z + .2 ) * 3.0, 0.0, 1.0 );

    reflectedLight.indirectSpecular *= reflectionMask;

