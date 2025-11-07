#!/usr/bin/env python3
"""
Try to match the 1.108 MHz filter coefficients from Rich/ChatGPT.
"""

import math

# Target coefficients from Rich (1.108 MHz cutoff)
TARGET = [
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

def hann_window(n, M):
    """Hann window."""
    return 0.5 - 0.5 * math.cos(2 * math.pi * n / (M - 1))

def kaiser_window(n, M, beta):
    """Kaiser window with parameter beta."""
    # Simplified I0 Bessel approximation
    arg = beta * math.sqrt(1 - ((2*n/(M-1) - 1)**2))
    return math.cosh(arg) / math.cosh(beta)

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
    """Calculate RMS error between generated and target coefficients."""
    if len(generated) != len(target):
        return float('inf')

    squared_errors = [(g - t)**2 for g, t in zip(generated, target)]
    return math.sqrt(sum(squared_errors) / len(squared_errors))

def main():
    NUM_TAPS = 21
    CUTOFF_HZ = 1.108e6  # Quarter subcarrier
    SAMPLE_RATE_HZ = 16e6
    cutoff_normalized = CUTOFF_HZ / (SAMPLE_RATE_HZ / 2.0)

    print(f"Matching 1.108 MHz filter (21 taps, cutoff {cutoff_normalized:.6f})")
    print(f"Target center tap: {TARGET[10]:.10f}\n")

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
        error = compare_coefficients(coeffs, TARGET)
        results.append((name, error, coeffs))
        print(f"{name:15s}: RMS error = {error:.10f}, center tap = {coeffs[10]:.10f}")

    print("\nBest match:")
    best_name, best_error, best_coeffs = min(results, key=lambda x: x[1])
    print(f"{best_name} (error: {best_error:.10f})")

    if best_error < 0.001:  # Good match
        print("\nGenerated coefficients (GLSL format):")
        for i in range(0, len(best_coeffs), 4):
            chunk = best_coeffs[i:i+4]
            print(f"    {'; '.join([f'FIR[{i+j}] = {c:.10g}' for j, c in enumerate(chunk)])};")

        print("\nComparison (first 5 taps):")
        for i in range(5):
            print(f"  [{i}] Target: {TARGET[i]:15.10f}  Generated: {best_coeffs[i]:15.10f}  Diff: {abs(TARGET[i]-best_coeffs[i]):.2e}")
    else:
        print("\nNo good match found. The filter might use a different design method.")
        print("Consider asking ChatGPT or using Rich's website to generate 51-tap version.")

if __name__ == '__main__':
    main()
