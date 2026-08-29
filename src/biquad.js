// Coefficients from the RBJ Audio EQ Cookbook: the second-order prototypes
// under a bilinear transform prewarped so the corner lands on `frequency`.
export class Biquad {
    constructor(b0, b1, b2, a1, a2) {
        this.b0 = b0;
        this.b1 = b1;
        this.b2 = b2;
        this.a1 = a1;
        this.a2 = a2;
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
    }

    static _fromUnnormalised(b0, b1, b2, a0, a1, a2) {
        return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
    }

    static _prototype(sampleRate, frequency, q) {
        const w0 = (2 * Math.PI * frequency) / sampleRate;
        return { alpha: Math.sin(w0) / (2 * q), cosW0: Math.cos(w0) };
    }

    static lowPass(sampleRate, frequency, q) {
        const { alpha, cosW0 } = Biquad._prototype(sampleRate, frequency, q);
        return Biquad._fromUnnormalised((1 - cosW0) / 2, 1 - cosW0, (1 - cosW0) / 2, 1 + alpha, -2 * cosW0, 1 - alpha);
    }

    static highPass(sampleRate, frequency, q) {
        const { alpha, cosW0 } = Biquad._prototype(sampleRate, frequency, q);
        return Biquad._fromUnnormalised(
            (1 + cosW0) / 2,
            -(1 + cosW0),
            (1 + cosW0) / 2,
            1 + alpha,
            -2 * cosW0,
            1 - alpha,
        );
    }

    /** A single RC high-pass: 6 dB per octave below the corner. */
    static firstOrderHighPass(sampleRate, frequency) {
        const k = Math.tan((Math.PI * frequency) / sampleRate);
        return Biquad._fromUnnormalised(1, -1, 0, 1 + k, k - 1, 0);
    }

    static peaking(sampleRate, frequency, q, gainDb) {
        const a = 10 ** (gainDb / 40);
        const { alpha, cosW0 } = Biquad._prototype(sampleRate, frequency, q);
        return Biquad._fromUnnormalised(
            1 + alpha * a,
            -2 * cosW0,
            1 - alpha * a,
            1 + alpha / a,
            -2 * cosW0,
            1 - alpha / a,
        );
    }

    static highShelf(sampleRate, frequency, q, gainDb) {
        const a = 10 ** (gainDb / 40);
        const { alpha, cosW0 } = Biquad._prototype(sampleRate, frequency, q);
        const root = 2 * Math.sqrt(a) * alpha;
        return Biquad._fromUnnormalised(
            a * (a + 1 + (a - 1) * cosW0 + root),
            -2 * a * (a - 1 + (a + 1) * cosW0),
            a * (a + 1 + (a - 1) * cosW0 - root),
            a + 1 - (a - 1) * cosW0 + root,
            2 * (a - 1 - (a + 1) * cosW0),
            a + 1 - (a - 1) * cosW0 - root,
        );
    }

    static gain(factor) {
        return new Biquad(factor, 0, 0, 0, 0);
    }

    /** Magnitude response at `frequency`, as a linear factor. */
    magnitudeAt(sampleRate, frequency) {
        const w = (2 * Math.PI * frequency) / sampleRate;
        const { b0, b1, b2, a1, a2 } = this;
        const cos1 = Math.cos(w);
        const sin1 = Math.sin(w);
        const cos2 = Math.cos(2 * w);
        const sin2 = Math.sin(2 * w);
        const numerator = Math.hypot(b0 + b1 * cos1 + b2 * cos2, b1 * sin1 + b2 * sin2);
        const denominator = Math.hypot(1 + a1 * cos1 + a2 * cos2, a1 * sin1 + a2 * sin2);
        return numerator / denominator;
    }

    process(buffer, offset, length) {
        const { b0, b1, b2, a1, a2 } = this;
        let { x1, x2, y1, y2 } = this;
        for (let i = offset; i < offset + length; ++i) {
            const x = buffer[i];
            const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            buffer[i] = y;
        }
        this.x1 = x1;
        this.x2 = x2;
        this.y1 = y1;
        this.y2 = y2;
    }
}
