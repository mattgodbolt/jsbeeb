#!/usr/bin/env python3
"""
Generate 51-tap versions of the PAL FIR filters.
Based on discovered pattern: Kaiser β=5, cutoff at 0.5× specified frequency.
"""

import math

def sinc(x):
    """Sinc function: sin(pi*x) / (pi*x), with sinc(0) = 1."""
    if abs(x) < 1e-10:
        return 1.0
    return math.sin(math.pi * x) / (math.pi * x)

def kaiser_window(n, M, beta):
    """Kaiser window with parameter beta."""
    arg = beta * math.sqrt(1 - ((2*n/(M-1) - 1)**2))
    return math.cosh(arg) / math.cosh(beta)

def generate_fir_lowpass(num_taps, cutoff_normalized, beta):
    """Generate FIR lowpass filter using Kaiser windowed sinc."""
    center = (num_taps - 1) / 2
    coefficients = []

    for n in range(num_taps):
        # Ideal lowpass filter (sinc function)
        t = n - center
        h = 2 * cutoff_normalized * sinc(2 * cutoff_normalized * t)

        # Apply Kaiser window
        w = kaiser_window(n, num_taps, beta)
        coefficients.append(h * w)

    # Normalize so sum equals 1.0
    total = sum(coefficients)
    coefficients = [c / total for c in coefficients]

    return coefficients

def format_glsl(coeffs, per_line=4):
    """Format coefficients as GLSL array."""
    lines = []
    for i in range(0, len(coeffs), per_line):
        chunk = coeffs[i:i+per_line]
        formatted = '; '.join([f'FIR[{i+j}] = {c:.10g}' for j, c in enumerate(chunk)])
        lines.append(f'    {formatted};')
    return '\n'.join(lines)

def generate_filter(num_taps, nominal_cutoff_mhz, label):
    """Generate filter with discovered parameters."""
    SAMPLE_RATE_HZ = 16e6
    BETA = 5.0

    # Key discovery: actual cutoff is 0.5× the specified frequency
    actual_cutoff_hz = nominal_cutoff_mhz * 1e6 * 0.5
    cutoff_normalized = actual_cutoff_hz / (SAMPLE_RATE_HZ / 2.0)

    print(f"\n{'='*70}")
    print(f"{label}")
    print(f"Nominal cutoff: {nominal_cutoff_mhz:.3f} MHz")
    print(f"Actual cutoff: {actual_cutoff_hz/1e6:.3f} MHz")
    print(f"Kaiser β: {BETA}")
    print(f"Taps: {num_taps}")
    print(f"{'='*70}\n")

    coeffs = generate_fir_lowpass(num_taps, cutoff_normalized, BETA)

    print(f"Sum: {sum(coeffs):.10f}")
    print(f"Center tap [{num_taps//2}]: {coeffs[num_taps//2]:.10f}\n")

    print("GLSL array initialization:")
    print(f"    const int FIRTAPS = {num_taps};")
    print(f"    float FIR[{num_taps}];")
    print(format_glsl(coeffs))

    return coeffs

def main():
    print("Generating 51-tap PAL FIR filters")
    print("Method: Kaiser window β=5, cutoff at 0.5× specified frequency")

    # Generate both filters
    coeffs_1108 = generate_filter(51, 1.108, "Quarter Subcarrier (1.108 MHz nominal)")
    coeffs_2217 = generate_filter(51, 2.217, "Half Subcarrier (2.217 MHz nominal)")

if __name__ == '__main__':
    main()
