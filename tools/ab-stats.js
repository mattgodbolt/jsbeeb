// The statistics of an A/B speed comparison, with no Node or browser dependencies, so the Node runner
// (tools/node-ab.js) and the browser one (tools/browser-ab.js) report the same thing in the same shape. A runner supplies
// one function that takes a fresh sample of a side's throughput; this alternates the sides, decides when to
// stop and summarises.

export const Confidence = 0.95;
// The verdict is checked after every pair, and each look is another chance of a false "faster" or "slower";
// at 99% per look, an A/A run ends in one about 5% of the time (simulated in test-ab-stats.js).
export const DecisionConfidence = 0.99;
// The fewest pairs with a DecisionConfidence signed-rank interval: all n pairs agreeing has probability 2^-n.
export const FewestDecisivePairs = Math.ceil(-Math.log2((1 - DecisionConfidence) / 2));
// The power the minimum detectable change is quoted at: a real change that size is seen four times in five.
export const Power = 0.8;

const LanczosG = 7;
const LanczosCoefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
const BetaIterations = 200;
const BetaEpsilon = 3e-14;
const BetaTiny = 1e-300;
const QuantileIterations = 100;
const QuantileUpperStart = 1;
export const PercentPerUnit = 100;

function lnGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    const shifted = x - 1;
    let sum = LanczosCoefficients[0];
    for (let i = 1; i < LanczosCoefficients.length; i++) sum += LanczosCoefficients[i] / (shifted + i);
    const t = shifted + LanczosG + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

// The continued fraction for the regularised incomplete beta function (Numerical Recipes, betacf).
function betaContinuedFraction(a, b, x) {
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < BetaTiny) d = BetaTiny;
    d = 1 / d;
    let result = d;
    for (let m = 1; m <= BetaIterations; m++) {
        const m2 = 2 * m;
        for (const term of [
            (m * (b - m) * x) / ((a + m2 - 1) * (a + m2)),
            (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1)),
        ]) {
            d = 1 + term * d;
            if (Math.abs(d) < BetaTiny) d = BetaTiny;
            c = 1 + term / c;
            if (Math.abs(c) < BetaTiny) c = BetaTiny;
            d = 1 / d;
            result *= d * c;
        }
        if (Math.abs(d * c - 1) < BetaEpsilon) break;
    }
    return result;
}

function regularisedBeta(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
    return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(T <= t) for Student's t with `df` degrees of freedom. */
export function studentTCdf(t, df) {
    const tail = 0.5 * regularisedBeta(df / 2, 0.5, df / (df + t * t));
    return t >= 0 ? 1 - tail : tail;
}

/** The t for which studentTCdf(t, df) is `p`. */
export function studentTQuantile(p, df) {
    if (p < 0.5) return -studentTQuantile(1 - p, df);
    const key = `${p} ${df}`;
    if (!quantiles.has(key)) quantiles.set(key, searchTQuantile(p, df));
    return quantiles.get(key);
}

const quantiles = new Map();

function searchTQuantile(p, df) {
    let low = 0;
    let high = QuantileUpperStart;
    while (studentTCdf(high, df) < p) high *= 2;
    for (let i = 0; i < QuantileIterations; i++) {
        const middle = (low + high) / 2;
        if (studentTCdf(middle, df) < p) low = middle;
        else high = middle;
    }
    return (low + high) / 2;
}

const medianOfSorted = (sorted) => {
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const median = (values) => medianOfSorted([...values].sort((a, b) => a - b));

const signedRankCdfs = new Map();

/** P(W <= w) for each w, where W is Wilcoxon's signed-rank statistic for `n` pairs with no real difference. */
export function signedRankCdf(n) {
    if (signedRankCdfs.has(n)) return signedRankCdfs.get(n);
    let probabilities = [1];
    for (let rank = 1; rank <= n; rank++) {
        const next = new Array(probabilities.length + rank).fill(0);
        for (const [sum, probability] of probabilities.entries()) {
            next[sum] += probability / 2;
            next[sum + rank] += probability / 2;
        }
        probabilities = next;
    }
    let cumulative = 0;
    const cdf = probabilities.map((probability) => (cumulative += probability));
    signedRankCdfs.set(n, cdf);
    return cdf;
}

// The mean of every pair of values, each value with itself included.
function walshAverages(values) {
    const averages = [];
    for (let i = 0; i < values.length; i++) {
        for (let j = i; j < values.length; j++) averages.push((values[i] + values[j]) / 2);
    }
    return averages.sort((a, b) => a - b);
}

/**
 * Compares paired throughputs, each pair an A and a B sample taken one after the other, so a machine that
 * slows down over the run moves both. Works on the log of each pair's ratio, so the result is on B/A and
 * symmetric in A and B: the Hodges-Lehmann estimate and the Wilcoxon signed-rank interval, which a few pairs
 * caught by other load on the machine do not drag about as they would a mean.
 * @param {{a: number, b: number}[]} pairs throughputs, higher is faster
 * @param {number} [confidence]
 * @returns {{ratio: number, low: number, high: number, minDetectableChange: number}} `ratio` is B/A, with the
 *     `confidence` interval [low, high], which is [0, Infinity] when there are too few pairs to reach that
 *     confidence; `minDetectableChange` is the fractional change this many pairs would take outside such an
 *     interval with probability `Power`, approximately: the interval's half-width scaled as a t interval's is
 */
export function comparePairs(pairs, confidence = Confidence) {
    const n = pairs.length;
    if (n < 2) throw new Error(`Comparing throughputs needs at least two pairs, not ${n}`);
    const averages = walshAverages(pairs.map(({ a, b }) => Math.log(b / a)));
    const ratio = Math.exp(medianOfSorted(averages));
    const tail = (1 - confidence) / 2;
    const cdf = signedRankCdf(n);
    // The interval runs from the `outside`+1'th smallest average to the `outside`+1'th largest.
    let outside = 0;
    while (cdf[outside] <= tail) outside++;
    if (outside === 0) return { ratio, low: 0, high: Infinity, minDetectableChange: Infinity };
    const logLow = averages[outside - 1];
    const logHigh = averages[averages.length - outside];
    const df = n - 1;
    const powerScale = 1 + studentTQuantile(Power, df) / studentTQuantile(1 - tail, df);
    return {
        ratio,
        low: Math.exp(logLow),
        high: Math.exp(logHigh),
        minDetectableChange: Math.exp(((logHigh - logLow) / 2) * powerScale) - 1,
    };
}

/**
 * What an interval says: "faster" or "slower" (B against A) when it excludes 1, "same" when it lies within
 * `horizon` (a fraction) either side of 1, otherwise "unresolved".
 */
export function verdict({ low, high }, horizon) {
    if (low > 1) return "faster";
    if (high < 1) return "slower";
    if (low >= 1 / (1 + horizon) && high <= 1 + horizon) return "same";
    return "unresolved";
}

/**
 * The comparison of `pairs` as a runner reports it: the ratio and its `Confidence` interval, and the verdict
 * and minimum detectable change from the wider `DecisionConfidence` interval.
 */
export function summarisePairs(pairs, horizon) {
    const reported = comparePairs(pairs);
    const decision = comparePairs(pairs, DecisionConfidence);
    return {
        ratio: reported.ratio,
        low: reported.low,
        high: reported.high,
        confidence: Confidence,
        decisionLow: decision.low,
        decisionHigh: decision.high,
        decisionConfidence: DecisionConfidence,
        verdict: verdict(decision, horizon),
        horizon,
        minDetectableChange: decision.minDetectableChange,
        pairs: pairs.length,
        aMedian: median(pairs.map(({ a }) => a)),
        bMedian: median(pairs.map(({ b }) => b)),
    };
}

/**
 * Samples A and B alternately, swapping which goes first in each pair (AB BA AB ...), until the verdict is not
 * "unresolved" after at least `minPairs` pairs, or `maxPairs` is reached.
 * @param {{sample: function('a'|'b'): Promise<number>, minPairs: number, maxPairs: number, horizon: number,
 *     onPair?: function(object): void}} options `sample` takes one fresh throughput sample of a side;
 *     `onPair` sees summarisePairs' result after each pair from the second on
 * @returns {Promise<object>} summarisePairs' result plus the raw `samples`
 */
export async function sampleUntilResolved({ sample, minPairs, maxPairs, horizon, onPair = () => {} }) {
    if (maxPairs < 2) throw new Error(`A comparison needs at least two pairs, so maxPairs cannot be ${maxPairs}`);
    const pairs = [];
    let summary = null;
    while (pairs.length < maxPairs) {
        const order = pairs.length % 2 ? ["b", "a"] : ["a", "b"];
        const pair = {};
        for (const side of order) pair[side] = await sample(side);
        pairs.push(pair);
        if (pairs.length < 2) continue;
        summary = summarisePairs(pairs, horizon);
        onPair(summary);
        if (pairs.length >= minPairs && summary.verdict !== "unresolved") break;
    }
    return { ...summary, samples: pairs };
}

const percent = (fraction, digits = 1) => `${(fraction * PercentPerUnit).toFixed(digits)}%`;
const signedPercent = (ratio) => `${ratio >= 1 ? "+" : ""}${percent(ratio - 1)}`;

/**
 * One line per workload for people: the change B makes, its interval, the verdict and what it could see, ending
 * with `engine` (what ran the samples, such as the Node version) when given.
 */
export function describeComparison(name, result, engine) {
    const { ratio, low, high, pairs, minDetectableChange, aMedian, bMedian } = result;
    const detectable = Number.isFinite(minDetectableChange)
        ? `min detectable change ${percent(minDetectableChange)}`
        : "too few to say what change they could detect";
    return (
        `${name}: B/A ${ratio.toFixed(3)} (${signedPercent(ratio)}), ` +
        `${percent(result.confidence, 0)} CI [${low.toFixed(3)}, ${high.toFixed(3)}], ${result.verdict}; ` +
        `${pairs} pairs, ${detectable}; ` +
        `median A ${aMedian.toFixed(2)}, B ${bMedian.toFixed(2)}${engine ? `; ${engine}` : ""}`
    );
}
