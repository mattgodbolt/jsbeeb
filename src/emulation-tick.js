// The machine runs in short slices of real time on a timer, whatever the
// display is doing (issue #885). Audio gains most from the fine grain: its
// queue need only cover a slice. execute()'s exit deopts, so anything timing
// the emulator runs it in slices of this size too.
export const TickMs = 10;
