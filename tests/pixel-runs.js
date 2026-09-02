/**
 * The length of the shortest run of equal texels between `from` and `to`.
 *
 * Both video chips are asked how wide a logical pixel is; this measures what
 * their blitters actually wrote, so the tests compare the recorded width
 * against the framebuffer rather than restating the arithmetic that produced
 * it.
 */
export function shortestRun(fb32, from, to) {
    let shortest = Infinity;
    let runStart = from;
    for (let x = from + 1; x <= to; ++x) {
        if (x === to || fb32[x] !== fb32[runStart]) {
            shortest = Math.min(shortest, x - runStart);
            runStart = x;
        }
    }
    return shortest;
}
