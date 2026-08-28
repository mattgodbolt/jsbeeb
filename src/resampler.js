function besselI0(x) {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 50; ++k) {
        term *= (x / (2 * k)) ** 2;
        sum += term;
        if (term < sum * 1e-12) break;
    }
    return sum;
}

/**
 * Rate conversion by a Kaiser-windowed sinc evaluated only where an output
 * sample falls, so the cost scales with the output rate, not the input rate.
 * The kernel is tabulated at `phases` fractional offsets and interpolated
 * between them. The caller renders each quantum's input into the buffer from
 * `inputBuffer`, reads its output with `read`, then calls `commit` to carry
 * the last `taps` input samples over as the next quantum's history.
 */
export class PolyphaseResampler {
    constructor(inputRate, cutoffHz, { taps = 201, phases = 64, beta = 8.5 } = {}) {
        this.taps = taps;
        this.phases = phases;
        this.half = (taps - 1) / 2;
        this.table = new Float32Array((phases + 1) * taps);
        const scale = (2 * cutoffHz) / inputRate;
        const norm = besselI0(beta);
        for (let p = 0; p <= phases; ++p) {
            const row = p * taps;
            let sum = 0;
            for (let k = 0; k < taps; ++k) {
                const t = k - this.half - p / phases;
                const x = Math.PI * scale * t;
                const sinc = x === 0 ? 1 : Math.sin(x) / x;
                const u = t / (this.half + 1);
                const window = u <= -1 || u >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - u * u)) / norm;
                this.table[row + k] = scale * sinc * window;
                sum += this.table[row + k];
            }
            for (let k = 0; k < taps; ++k) this.table[row + k] /= sum;
        }
        this.buffer = new Float32Array(taps);
        this.newSamples = 0;
    }

    /** Where to render `count` new input samples; the history precedes it. */
    inputBuffer(count) {
        const needed = this.taps + count + 1;
        if (this.buffer.length < needed) {
            const grown = new Float32Array(needed * 2);
            grown.set(this.buffer.subarray(0, this.taps));
            this.buffer = grown;
        }
        this.newSamples = count;
        return this.buffer.subarray(this.taps, this.taps + count);
    }

    /**
     * Fill `out` with samples taken `ratio` input samples apart, the first at
     * `phase` (0 to 1) past the last sample of the previous quantum. The
     * output lags the input by `half` samples, which the kernel needs ahead.
     */
    read(out, phase, ratio) {
        const { buffer, table, taps, phases } = this;
        for (let i = 0; i < out.length; ++i) {
            const pos = phase + i * ratio;
            const loc = Math.floor(pos);
            const fracPhase = (pos - loc) * phases;
            const p = Math.floor(fracPhase);
            const mix = fracPhase - p;
            const rowA = p * taps;
            const rowB = rowA + taps;
            let a = 0;
            let b = 0;
            for (let k = 0; k < taps; ++k) {
                const x = buffer[loc + k];
                a += table[rowA + k] * x;
                b += table[rowB + k] * x;
            }
            out[i] = a + (b - a) * mix;
        }
    }

    /** Keep the last `taps` input samples as history for the next quantum. */
    commit() {
        this.buffer.copyWithin(0, this.newSamples, this.newSamples + this.taps);
    }
}
