// The page runs the machine in short slices of real time on a timer (src/web/emulation-loop.js), whatever the
// display is doing (issue #885). Audio gains most from the fine grain: its queue need only cover a slice. Whatever
// else runs execute() (the benchmarks, the same-answer check) uses slices of this size too, to call it as the
// page does: its exit deopts, so the slice size changes what runs.
export const TickMs = 10;
const MsPerSecond = 1000;

/** The CPU cycles one tick runs on a machine of `cyclesPerSecond`. */
export const tickCycles = (cyclesPerSecond) => (cyclesPerSecond * TickMs) / MsPerSecond;
