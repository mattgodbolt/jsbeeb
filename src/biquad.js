// Coefficients from the RBJ Audio EQ Cookbook: the second-order prototype
// under a bilinear transform prewarped so the corner lands on `frequency`.
export class LowPassBiquad {
    constructor(sampleRate, frequency, q) {
        const w0 = (2 * Math.PI * frequency) / sampleRate;
        const alpha = Math.sin(w0) / (2 * q);
        const cosW0 = Math.cos(w0);
        const a0 = 1 + alpha;
        this.b0 = (1 - cosW0) / (2 * a0);
        this.b1 = (1 - cosW0) / a0;
        this.a1 = (-2 * cosW0) / a0;
        this.a2 = (1 - alpha) / a0;
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
    }

    process(buffer, offset, length) {
        const { b0, b1, a1, a2 } = this;
        let { x1, x2, y1, y2 } = this;
        for (let i = offset; i < offset + length; ++i) {
            const x = buffer[i];
            const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
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
