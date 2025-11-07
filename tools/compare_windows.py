#!/usr/bin/env python3
"""
Try different window functions to match the original 21-tap FIR coefficients.
"""

import math

# Original 21-tap coefficients from friend (2.217 MHz - half subcarrier)
ORIGINAL_2217 = [
    0.000427769337, 0.00231068052, 0.00344911363, -0.00203420476,
    -0.0168416192, -0.0301975906, -0.0173992619, 0.0424187581,
    0.141605897, 0.237531717, 0.277457482, 0.237531717,
    0.141605897, 0.0424187581, -0.0173992619, -0.0301975906,
    -0.0168416192, -0.00203420476, 0.00344911363, 0.00231068052,
    0.000427769337
]

# Alternative 21-tap coefficients (1.108 MHz - quarter subcarrier)
ORIGINAL_1108 = [
    -0.000638834376, -0.0016986177, -0.00191473412, 0.00108939462,
    0.0102771892, 0.0278912703, 0.0539186832, 0.085139644,
    0.115453168, 0.137610031, 0.145745611, 0.137610031,
    0.115453168, 0.085139644, 0.0539186832, 0.0278912703,
    0.0102771892, 0.00108939462, -0.00191473412, -0.0016986177,
    -0.000638834376
]

def sinc(x):
    """Sinc function: sin(pi*x) / (pi*x), with sinc(0) = 1."""
    if abs(x) < 1e-10:
        return 1.0
    return math.sin(math.pi * x) / (math.pi * x)

def hamming_window(n, M):
    """Hamming window."""
    return 0.54 - 0.46 * math.cos(2 * math.pi * n / (M - 1))

def blackman_window(n, M):
    """Blackman window."""
    a0 = 0.42
    a1 = 0.5
    a2 = 0.08
    return a0 - a1 * math.cos(2 * math.pi * n / (M - 1)) + a2 * math.cos(4 * math.pi * n / (M - 1))

def kaiser_window(n, M, beta):
    """Kaiser window with parameter beta."""
    # Simplified Kaiser - would need scipy for proper I0 Bessel function
    # This is an approximation
    arg = beta * math.sqrt(1 - ((2*n/(M-1) - 1)**2))
    # Rough approximation of modified Bessel function I0
    return math.cosh(arg) / math.cosh(beta)

def rectangular_window(n, M):
    """Rectangular (no) window."""
    return 1.0

def hann_window(n, M):
    """Hann window."""
    return 0.5 - 0.5 * math.cos(2 * math.pi * n / (M - 1))

def generate_fir_lowpass(num_taps, cutoff_normalized, window_func):
    """Generate FIR lowpass filter using windowed sinc method."""
    center = (num_taps - 1) / 2
    coefficients = []

    for n in range(num_taps):
        # Ideal lowpass filter (sinc function)
        t = n - center
        h = 2 * cutoff_normalized * sinc(2 * cutoff_normalized * t)

        # Apply window
        w = window_func(n, num_taps)
        coefficients.append(h * w)

    # Normalize so sum equals 1.0
    total = sum(coefficients)
    coefficients = [c / total for c in coefficients]

    return coefficients

def compare_coefficients(generated, original):
    """Calculate RMS error between generated and original coefficients."""
    if len(generated) != len(original):
        return float('inf')

    squared_errors = [(g - o)**2 for g, o in zip(generated, original)]
    return math.sqrt(sum(squared_errors) / len(squared_errors))

def test_filter(target, cutoff_hz, label):
    """Test different windows against a target filter."""
    NUM_TAPS = 21
    SAMPLE_RATE_HZ = 16e6
    cutoff_normalized = cutoff_hz / (SAMPLE_RATE_HZ / 2.0)

    print(f"\n{'='*70}")
    print(f"{label}")
    print(f"Cutoff: {cutoff_hz/1e6:.3f} MHz, Normalized: {cutoff_normalized:.6f}")
    print(f"Target center tap: {target[10]:.10f}")
    print(f"{'='*70}\n")

    windows = [
        ("Hamming", lambda n, M: hamming_window(n, M)),
        ("Hann", lambda n, M: hann_window(n, M)),
        ("Blackman", lambda n, M: blackman_window(n, M)),
        ("Kaiser β=2", lambda n, M: kaiser_window(n, M, 2.0)),
        ("Kaiser β=3", lambda n, M: kaiser_window(n, M, 3.0)),
        ("Kaiser β=4", lambda n, M: kaiser_window(n, M, 4.0)),
        ("Kaiser β=5", lambda n, M: kaiser_window(n, M, 5.0)),
        ("Kaiser β=6", lambda n, M: kaiser_window(n, M, 6.0)),
        ("Kaiser β=7", lambda n, M: kaiser_window(n, M, 7.0)),
        ("Kaiser β=8", lambda n, M: kaiser_window(n, M, 8.0)),
    ]

    results = []
    for name, window_func in windows:
        coeffs = generate_fir_lowpass(NUM_TAPS, cutoff_normalized, window_func)
        error = compare_coefficients(coeffs, target)
        results.append((name, error, coeffs))
        print(f"{name:15s}: RMS error = {error:.10f}, center tap = {coeffs[10]:.10f}")

    print("\nBest match:")
    best_name, best_error, best_coeffs = min(results, key=lambda x: x[1])
    print(f"{best_name} (error: {best_error:.10f})")

    if best_error < 0.01:
        print("\nGenerated coefficients (GLSL format):")
        for i in range(0, len(best_coeffs), 4):
            chunk = best_coeffs[i:i+4]
            print(f"    {'; '.join([f'FIR[{i+j}] = {c:.10g}' for j, c in enumerate(chunk)])};")
    else:
        print("\nNo close match found - ChatGPT/website might use different method")

    return best_name, best_error, best_coeffs

def main():
    print("Trying to match FIR coefficients from Rich (via ChatGPT)")

    # Test both filters
    test_filter(ORIGINAL_2217, 2.217e6, "Filter 1: Half Subcarrier (2.217 MHz)")
    test_filter(ORIGINAL_1108, 1.108e6, "Filter 2: Quarter Subcarrier (1.108 MHz)")

if __name__ == '__main__':
    main()
