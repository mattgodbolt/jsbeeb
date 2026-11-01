// The page runs the machine in short slices of real time on a timer (src/web/emulation-loop.js), whatever the
// display is doing (issue #885). Audio gains most from the fine grain: its queue need only cover a slice. Whatever
// else runs execute() (the benchmarks, the same-answer check) uses slices of this size too, to call it as the
// page does: its exit deopts, so the slice size changes what runs.
export const TickMs = 10;
// The frames a second the page counts its frame captures in, and a session spaces its recent snapshots by: the
// PAL picture's 50 fields a second, used for the Atom's 60 Hz picture too.
export const FramesPerSecond = 50;
const MsPerSecond = 1000;

/** The CPU cycles one tick runs on a machine of `cyclesPerSecond`. */
export const tickCycles = (cyclesPerSecond) => (cyclesPerSecond * TickMs) / MsPerSecond;
