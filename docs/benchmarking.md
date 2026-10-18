# Benchmarking

How to tell whether a change makes the emulator faster. The workloads are the snapshots in
`public/benchmarks` (see `src/benchmark-workloads.js`); `npm run benchmark` gives a quick look at their speed in
Node, and the A/B runner below says whether a difference between two commits is real.

## Node A/B runner

```sh
node tools/node-ab.js <A> <B> [workload ...] [options]
```

A and B are git refs or paths to existing checkouts. A ref is checked out into a temporary worktree (in the
system temp directory, or `--work-dir`) that is removed afterwards; its `node_modules` is a link to the one
Node finds for this checkout (in it or a directory above) when the lock files match apart from the package's own version, and its own `npm ci` otherwise. A
path is used as it is, uncommitted changes and all, so an agent can compare its working tree against a
worktree of the commit it started from; it needs its packages installed (or a `node_modules` in a directory
above it, as a worktree under `.claude/worktrees` finds the main checkout's). Both sides need the benchmark
workloads, so neither can predate them. A run killed outright (`kill -9`) leaves its worktrees behind;
`git worktree prune` after deleting their directories tidies them up.

With no workloads named, every workload in A's manifest runs, one after another. `--fake-video` measures the
CPU and peripherals without rendering video; the difference from a run without it is the video's cost.
`node tools/node-ab.js --help` lists the rest.

Each sample is a fresh Node process, so no side inherits the other's type feedback or compiled code. It
restores the workload from its side's checkout, runs `--warmup-secs` emulated seconds (5) for the JIT tiers to
settle, then times `--measure-secs` (10) in 10 ms slices of emulated time, the size of the page's tick
(`TickMs` in `src/web/emulation-loop.js`), since `execute()`'s exit deopts and the slice size changes what is
measured. A sample's throughput is its median slice's virtual MHz: a busy machine stalls runs of slices, which
the median ignores and the total time does not. `--statistic total` uses the total time instead, which also
counts the rare slow slices (a garbage collection, a costly stretch of the program) that the median leaves out.

The runner takes the two sides in pairs, swapping which goes first (AB BA AB ...), and compares the log of
each pair's B/A. It reports B/A as the Hodges-Lehmann estimate with the Wilcoxon signed-rank 95% interval,
which a few pairs caught by other load drag about less than a mean and t interval. It stops when the
verdict is decided, after at least `--min-pairs` (8), or at `--max-pairs` (30):

- **faster** or **slower**: B against A, when the 99% interval excludes 1.
- **same**: the 99% interval lies within `--horizon` (2%) of 1.
- **unresolved**: neither, at the cap.

The verdict uses a 99% interval because it is checked after every pair, and each look is another chance of a
false "faster" or "slower"; with 99% an A/A run ends in one about 5% of the time. For 7 pairs or fewer no 99%
interval exists. The minimum detectable change is the change that this many pairs, this noisy, would call
faster or slower four times in five.

One line per workload is printed, and `--json FILE` writes the full result for scripts: each side's ref and
sha (a path's sha gains `-dirty` with uncommitted changes to tracked files), the settings, and per workload the ratio, both
intervals, the verdict, the minimum detectable change, the pairs used in the statistics and every sample's raw
numbers. With too few pairs for an interval, its bounds are 0 and `null` (JSON's spelling of infinity), and
so is the minimum detectable change.

`--cpu-prof a|b|both` and `--trace-deopt a|b|both` add one more run per workload of the chosen sides after the
timed ones, under that V8 flag, so the profiling never slows a timed run. The `.cpuprofile` files (open them
in Chrome DevTools' Performance panel) and `.deopt.log` files go in `--out-dir` (`node-ab-out`), named by side,
ref and workload.

## Keeping runs quiet

- Run nothing else heavy at the same time: a build, a test suite or a second A/B run on the same machine
  skews both, and two A/B runs at once are each other's noise. The minimum detectable change says how much
  the noise cost.
- Run the A/B at normal priority and anything else under `nice -n 19`; niceing the A/B itself only lets the
  other load take its time.
- A laptop on mains power with little else running gives about ±1% between samples; a busy desktop gives
  several times that, with whole samples stalled.
- CPU frequency scaling and thermal throttling move every sample. On Linux, the `performance` governor
  (`cpupower frequency-set -g performance`) holds the clock up; the alternating pairs keep a slow drift from
  favouring either side, but not a sudden change.

## Sharing the statistics

`tools/ab-stats.js` has no Node or browser dependencies. A runner supplies `sample(side)`, which takes one
fresh throughput sample of side `"a"` or `"b"`; `sampleUntilResolved` alternates the sides, stops and
summarises, and `describeComparison` prints the line. The browser A/B (#1340) is meant to supply a `sample`
that opens a fresh page on that side's build and reads the `?benchmark` result, and so to report the same
result in the same shape.
