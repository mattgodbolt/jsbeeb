export const DefaultTargetLatencyMs = 1000 * (1 / 50); // One frame
export const MaxTargetLatencyMs = 250;

// A lead kept this far past the target for this long is skipped back to it.
export const ExcessLeadMs = 50;
export const PersistentExcessSeconds = 0.5;

export function validTargetLatencyMs(ms) {
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MaxTargetLatencyMs) : DefaultTargetLatencyMs;
}
