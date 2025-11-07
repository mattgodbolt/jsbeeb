#!/usr/bin/env python3
"""
Generate FIR filter coefficients for PAL composite video chroma filtering.

Specifications:
- Cutoff frequency: 2.217 MHz (half the PAL subcarrier frequency)
- Sample rate: 16 MHz (full scanline pixel clock)
- Filter type: Lowpass with Hamming window

No external dependencies - pure Python implementation.
"""

import math

def hamming_window(n, M):
    """Generate Hamming window value at position n of M total samples."""
    return 0.54 - 0.46 * math.cos(2 * math.pi * n / (M - 1))

def sinc(x):
    """Sinc function: sin(pi*x) / (pi*x), with sinc(0) = 1."""
    if abs(x) < 1e-10:
        return 1.0
    return math.sin(math.pi * x) / (math.pi * x)

def generate_fir_lowpass(num_taps, cutoff_normalized):
    """
    Generate FIR lowpass filter using windowed sinc method.

    Args:
        num_taps: Number of filter taps (must be odd)
        cutoff_normalized: Cutoff frequency normalized to Nyquist (0-1)

    Returns:
        List of filter coefficients
    """
    if num_taps % 2 == 0:
        raise ValueError("num_taps must be odd for symmetric filter")

    center = (num_taps - 1) / 2
    coefficients = []

    for n in range(num_taps):
        # Ideal lowpass filter (sinc function)
        t = n - center
        h = 2 * cutoff_normalized * sinc(2 * cutoff_normalized * t)

        # Apply Hamming window
        w = hamming_window(n, num_taps)
        coefficients.append(h * w)

    # Normalize so sum equals 1.0
    total = sum(coefficients)
    coefficients = [c / total for c in coefficients]

    return coefficients

def format_glsl_array(coefficients, per_line=4):
    """Format coefficients as GLSL array initialization."""
    lines = []
    for i in range(0, len(coefficients), per_line):
        chunk = coefficients[i:i+per_line]
        formatted = '; '.join([f'FIR[{i+j}] = {coef:.10g}' for j, coef in enumerate(chunk)])
        lines.append(f'    {formatted};')
    return '\n'.join(lines)

def main():
    # PAL chroma filter specifications
    NUM_TAPS = 21  # Changed to 21 to compare with original
    CUTOFF_HZ = 2.217e6  # 2.217 MHz
    SAMPLE_RATE_HZ = 16e6  # 16 MHz

    # Normalize cutoff to Nyquist frequency
    nyquist_hz = SAMPLE_RATE_HZ / 2.0
    cutoff_normalized = CUTOFF_HZ / nyquist_hz

    print(f"Generating {NUM_TAPS}-tap FIR filter")
    print(f"Cutoff: {CUTOFF_HZ/1e6:.3f} MHz")
    print(f"Sample rate: {SAMPLE_RATE_HZ/1e6:.1f} MHz")
    print(f"Normalized cutoff: {cutoff_normalized:.6f}")
    print()

    # Generate coefficients
    coefficients = generate_fir_lowpass(NUM_TAPS, cutoff_normalized)

    # Verify symmetry
    is_symmetric = all(abs(coefficients[i] - coefficients[-(i+1)]) < 1e-10
                      for i in range(NUM_TAPS // 2))
    print(f"Symmetric: {is_symmetric}")
    print(f"Sum of coefficients: {sum(coefficients):.10f}")
    print(f"Center tap value: {coefficients[NUM_TAPS//2]:.10f}")
    print()

    # Output for GLSL
    print("GLSL array initialization:")
    print(f"    const int FIRTAPS = {NUM_TAPS};")
    print(f"    float FIR[{NUM_TAPS}];")
    print(format_glsl_array(coefficients))
    print()

    # Also output raw values for reference
    print("\nRaw coefficient values (for verification):")
    for i, coef in enumerate(coefficients):
        print(f"  [{i:2d}] = {coef:.12f}")

if __name__ == '__main__':
    main()
