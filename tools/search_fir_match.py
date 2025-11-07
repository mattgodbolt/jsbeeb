#!/usr/bin/env python3
"""
More aggressive search to match Rich's FIR coefficients.
Try varying cutoff frequency and window parameters.
"""

import math

# Target coefficients from Rich (1.108 MHz cutoff)
TARGET_1108 = [
    -0.000638834376, -0.0016986177, -0.00191473412, 0.00108939462,
    0.0102771892, 0.0278912703, 0.0539186832, 0.085139644,
    0.115453168, 0.137610031, 0.145745611, 0.137610031,
    0.115453168, 0.085139644, 0.0539186832, 0.0278912703,
    0.0102771892, 0.00108939462, -0.00191473412, -0.0016986177,
    -0.000638834376
]

TARGET_2217 = [
    0.000427769337, 0.00231068052, 0.00344911363, -0.00203420476,
    -0.0168416192, -0.0301975906, -0.0173992619, 0.0424187581,
    0.141605897, 0.237531717, 0.277457482, 0.237531717,
    0.141605897, 0.0424187581, -0.0173992619, -0.0301975906,
    -0.0168416192, -0.00203420476, 0.00344911363, 0.00231068052,
    0.000427769337
]

def sinc(x):
    """Sinc function: sin(pi*x) / (pi*x), with sinc(0) = 1."""
    if abs(x) < 1e-10:
        return 1.0
    return math.sin(math.pi * x) / (math.pi * x)

def kaiser_window(n, M, beta):
    """Kaiser window using simplified I0 Bessel approximation."""
    arg = beta * math.sqrt(1 - ((2*n/(M-1) - 1)**2))
    return math.cosh(arg) / math.cosh(beta)

def blackman_window(n, M):
    """Blackman window."""
    a0 = 0.42
    a1 = 0.5
    a2 = 0.08
    return a0 - a1 * math.cos(2 * math.pi * n / (M - 1)) + a2 * math.cos(4 * math.pi * n / (M - 1))

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

def compare_coefficients(generated, target):
    """Calculate RMS error."""
    if len(generated) != len(target):
        return float('inf')
    squared_errors = [(g - t)**2 for g, t in zip(generated, target)]
    return math.sqrt(sum(squared_errors) / len(squared_errors))

def search_best_match(target, nominal_cutoff_mhz, label):
    """Search across cutoff frequencies and window parameters."""
    NUM_TAPS = 21
    SAMPLE_RATE_HZ = 16e6

    print(f"\n{'='*70}")
    print(f"{label}")
    print(f"Nominal cutoff: {nominal_cutoff_mhz:.3f} MHz")
    print(f"Target center tap: {target[10]:.10f}")
    print(f"{'='*70}\n")

    best_overall = None
    best_error = float('inf')

    # Try different cutoff frequencies around the nominal
    cutoff_range = [
        nominal_cutoff_mhz * f
        for f in [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5]
    ]

    # Try different window types and parameters
    test_cases = []

    # Blackman
    for cutoff_mhz in cutoff_range:
        test_cases.append((
            f"Blackman @ {cutoff_mhz:.3f}MHz",
            cutoff_mhz,
            lambda n, M: blackman_window(n, M)
        ))

    # Kaiser with various beta
    for beta in [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14]:
        for cutoff_mhz in cutoff_range:
            test_cases.append((
                f"Kaiser β={beta} @ {cutoff_mhz:.3f}MHz",
                cutoff_mhz,
                lambda n, M, b=beta: kaiser_window(n, M, b)
            ))

    print(f"Testing {len(test_cases)} combinations...")

    for name, cutoff_mhz, window_func in test_cases:
        cutoff_normalized = (cutoff_mhz * 1e6) / (SAMPLE_RATE_HZ / 2.0)
        coeffs = generate_fir_lowpass(NUM_TAPS, cutoff_normalized, window_func)
        error = compare_coefficients(coeffs, target)

        if error < best_error:
            best_error = error
            best_overall = (name, error, coeffs, cutoff_mhz)

    if best_overall:
        name, error, coeffs, cutoff_mhz = best_overall
        print(f"\nBest match: {name}")
        print(f"RMS error: {error:.10f}")
        print(f"Center tap: {coeffs[10]:.10f} (target: {target[10]:.10f})")

        if error < 0.01:
            print("\nGLSL coefficients:")
            for i in range(0, len(coeffs), 4):
                chunk = coeffs[i:i+4]
                print(f"    {'; '.join([f'FIR[{i+j}] = {c:.10g}' for j, c in enumerate(chunk)])};")

            print("\nDetailed comparison (first 5 taps):")
            for i in range(5):
                print(f"  [{i:2d}] Target: {target[i]:15.10f}  Generated: {coeffs[i]:15.10f}  Diff: {abs(target[i]-coeffs[i]):.2e}")
        else:
            print(f"\nError still too high ({error:.6f}). Might need different design method.")
            print("Consider asking ChatGPT directly for 51-tap version.")

    return best_overall

def main():
    print("Comprehensive search for FIR coefficient matches")

    # Search for both filters
    result_1108 = search_best_match(TARGET_1108, 1.108, "Quarter Subcarrier Filter (1.108 MHz)")
    result_2217 = search_best_match(TARGET_2217, 2.217, "Half Subcarrier Filter (2.217 MHz)")

if __name__ == '__main__':
    main()
