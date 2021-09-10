    // Screen shader epilog (inserted near the end of main)

    // Fade emissive based on transmittance from fresnel (as it is behind the glass)
    // we need to do this at this point (later than emissive) in the shader so we have access to the other material variables
    totalEmissiveRadiance *= 1.0f - BRDF_Specular_GGX_Environment( geometry.viewDir, geometry.normal, vec3( DEFAULT_SPECULAR_COEFFICIENT ), material.specularRoughness);
