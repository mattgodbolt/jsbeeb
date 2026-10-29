# Benchmarking

How to tell whether a change makes the emulator faster. The workloads are the snapshots in
`public/benchmarks` (see `src/benchmark-workloads.js`); `npm run benchmark` gives a quick look at their speed in
Node, the page's `?benchmark=<workload>` mode measures them in a browser (see the README), and the A/B runners
below say whether a difference between two commits is real: the Node one quickly, as a proxy (in Node or in
the engines' own shells), and the browser one where it matters.

## Node A/B runner

```sh
npm run benchmark:ab -- <A> <B> [workload ...] [options]
```

npm runs it from the checkout's root, so relative paths (a side, `--json`, `--out-dir`, `--work-dir`) are taken
from there. `npm run -s` leaves out npm's own banner lines, for a script reading the output.

A and B are git refs or paths to existing checkouts. A ref is checked out into a temporary worktree (in the system
temp directory, or `--work-dir`, made if missing) that is removed afterwards, also on Ctrl-C, SIGTERM or SIGHUP
(the npm script `exec`s Node, so a SIGTERM sent to npm reaches it). When the lock files match apart from the
package's own version, its `node_modules` is a link to the nearest one in or above this checkout whose
`.package-lock.json` (npm's record of what it installed) has every non-optional package this checkout's lock file
names, at its locked version; when they differ, it gets its own `npm ci`. A path is used as it is, uncommitted
changes and all, so an agent can compare its working tree against a worktree of the commit it started from; it
needs its packages installed (or a `node_modules` in a directory above it, as a worktree under `.claude/worktrees`
finds the main checkout's). Both sides need the benchmark workloads, so neither can predate them. A run killed
outright (`kill -9`) leaves its worktrees behind; `git worktree prune` after deleting their directories tidies them
up.

With no workloads named, every workload in A's manifest runs, one after another. `--fake-video` measures the
CPU and peripherals without rendering video; the difference from a run without it is the video's cost.
`npm run benchmark:ab -- --help` lists the rest.

Each sample is a fresh Node process, so no side inherits the other's type feedback or compiled code. It
restores the workload from its side's checkout, runs `--warmup-secs` emulated seconds (5) for the JIT tiers to
settle, then times `--measure-secs` (10) in slices of emulated time the size of the page's tick
(`TickMs` in `src/emulation-tick.js`), since `execute()`'s exit deopts and the slice size changes what is
measured. Both sides run on the runner's own Node, whatever version each side's `package.json` asks for, so the
comparison is of the code and not of two engines. The version goes on every result line and in the JSON
(`node`): results from different Node versions are not comparable, nor are results from different machines.

A sample's throughput is its median slice's virtual MHz: a busy machine stalls runs of slices, which
the median ignores and the total time does not. `--statistic total` uses the total time instead, which also
counts the rare slow slices (a garbage collection, a costly stretch of the program) that the median leaves out.

The runner takes the two sides in pairs, swapping which goes first (AB BA AB ...), and compares the log of
each pair's B/A. It reports B/A as the Hodges-Lehmann estimate with the Wilcoxon signed-rank 95% interval,
which a few pairs caught by other load drag about less than a mean and t interval. It stops when the
verdict is decided, after at least `--min-pairs` (8), or at `--max-pairs` (30):

- **faster** or **slower**: B against A, when the 99% interval excludes 1.
- **same**: the 99% interval lies within `--horizon` (2%) of 1.
- **unresolved**: neither, at the cap.

The verdict uses a 99% interval because it is checked after every pair, and each look is another chance of a false
"faster" or "slower"; with 99% an A/A run ends in one about 5% of the time. For 7 pairs or fewer no 99% interval
exists; the progress line printed after each pair shows the 95% one, which exists from 6 pairs. The minimum
detectable change is the change that this many pairs, this noisy, would call faster or slower four times in five.

One line per workload is printed, and `--json FILE` writes the full result for scripts: each side's ref and
sha (a path's sha gains `-dirty` with uncommitted changes to tracked files), the settings, and per workload
the ratio, both intervals, the verdict, the minimum detectable change (as a fraction), the pairs used in the
statistics and every sample's raw numbers. It is written as soon as the timed runs end, and again after any
profiling runs; its directory is checked before anything runs.

`--cpu-prof a|b|both` and `--trace-deopt a|b|both` add one more run per workload of the chosen sides after the
timed ones, under that V8 flag, so the profiling never slows a timed run. The `.cpuprofile` files (open them
in Chrome DevTools' Performance panel) and `.deopt.log` files go in `--out-dir` (`node-ab-out`), named by side,
ref and workload.

## Engine shells

The Node A/B also runs in the engines' own shells, without a browser: V8's `d8`, SpiderMonkey's `js` (Firefox) and
JavaScriptCore's `jsc` (Safari). [jsvu](https://github.com/GoogleChromeLabs/jsvu) installs them in `~/.jsvu`:

```sh
npx jsvu --os=default --engines=v8,spidermonkey,javascriptcore
npm run benchmark:ab -- <A> <B> [workload ...] --engine spidermonkey
npm run benchmark:shell -- --engine javascriptcore [workload ...]
```

`--engine` is `v8`, `spidermonkey` or `javascriptcore` (jsvu's names), and `--shell PATH` names a shell jsvu did
not install. Each side is bundled once (`tools/shell-bench.js`), with this checkout's sampling code around the
side's `src/benchmark-machine.js`, and each sample is a fresh shell running that bundle. `tools/shell-host.js`
supplies what the shells lack: file reading, the few Node functions the machine's code reaches, and the browser's
`TextDecoder`, `atob` and `EventTarget`. The result line and the JSON (`engine`) give jsvu's version of the
engine. `--cpu-prof` and `--trace-deopt` are Node's, so they need `--engine node`.
`npm run benchmark:shell` prints each workload's speed once, for a quick look.

## Browser A/B runner

```sh
npm run benchmark:browser-ab -- <A> <B> [workload ...] [options]
```

The same comparison in a browser, driving the page's `?benchmark=<workload>` mode. A and B are git refs, paths to
checkouts (taken as for the Node runner) or paths to pages already built (a `dist` folder). Each checkout, a ref's
worktree included, is built with its own `vite` into a folder of its own in `--work-dir`, without analytics, and
removed afterwards; a built page is used as it is. Both sides are then served by the runner's own Vite `preview()`,
without either side's config, on two loopback ports with the same headers and no caching, so the only difference
between them is the build. Nothing else is fetched: requests off the loopback address are refused.
`npm run benchmark:browser-ab -- --help` lists the options.

Each sample is a fresh page in a fresh browser context, so no side inherits the other's compiled JavaScript or
page caches (the GPU process, and its compiled shaders, outlive a context); `--fresh browser` launches a whole
browser per sample instead. On a busy desktop neither gave the
lower spread between samples, so the cheaper one is the default. The page restores the workload, warms up and
times ten emulated seconds in three passes (see the README); a sample's throughput is its `--pass` (`full`,
the default, as a person runs it; `video`, without the copy and present; or `cpu`, with fake video) in
virtual MHz, from its median emulated second, or with `--statistic total` from all ten. The page's seconds
play the part of the Node runner's slices, a hundred times coarser. The pairs, the statistics, the stopping rule
and the result line are the Node runner's; the line ends with the browser, its version and the renderer, and the
run stops if any page differs from the first in renderer, display, cross-origin isolation or user agent.
`--json FILE` writes each sample's every emulated second for each pass as well.

The browser is a project from `playwright.config.js` (`--project`): `chrome`, the system Chrome headless, by
default, as the e2e suite uses; `chromium`, `firefox` or `webkit` once `npx playwright install` has fetched it.
Firefox and WebKit are Playwright's patched builds, not the branded browsers, so their numbers compare two
builds with each other and nothing more. Chrome draws with the software renderer (SwiftShader) unless
`--gl hardware` asks for the GPU. Software is what CI uses and the same on any machine, but its present runs on
the CPU and is about a third of the `full` pass's time on Elite; the GPU's present is closer to what people see,
but varies with the GPU and its driver, and a Chrome that cannot reach the GPU never finishes the page (the
sample times out after five minutes). `--pass video` leaves the present out altogether.

`--cpu-prof a|b|both` loads one more page per workload of the chosen sides after the timed ones, with Chrome's
profiler (through the DevTools protocol) running from when the page has loaded until its result is in, and writes
the `.cpuprofile` to `--out-dir` (`browser-ab-out`). Open it in Chrome DevTools' Performance panel.

A run cleans up its worktrees, builds, servers and browsers when it ends, also on Ctrl-C, SIGTERM or SIGHUP.

## Keeping runs quiet

- Run nothing else heavy at the same time: a build, a test suite or a second A/B run on the same machine
  skews both, and two A/B runs at once are each other's noise. The minimum detectable change says how much
  the noise cost.
- Run the A/B at normal priority and anything else under `nice -n 19`; niceing the A/B itself only lets the
  other load take its time.
- A laptop on mains power with little else running gives about ±1% between samples; a busy desktop gives
  several times that, with whole samples stalled.
- Clock speed moves every sample: turbo drops as other cores get busy, and a hot machine throttles. The
  alternating pairs keep a slow drift from favouring either side, but not a sudden change. Under Linux's
  `intel_pstate` driver, what the `powersave` governor does depends on the energy-performance preference: with
  `balance_performance` it lets busy cores turbo, while `balance_power` or `power` holds them lower. The
  `performance` governor (`cpupower frequency-set -g performance`) takes the question away.
- A browser's samples vary much more than Node's, on a quiet machine as much as a busy one: each emulated
  second in a page varies by 8 to 25%, and the `video` and `cpu` passes also settle at a different speed in
  each page. With the defaults the browser A/B resolves about 4% on the `full` pass; seeing 2% takes about
  four times the pairs (`--max-pairs 120`, over half an hour a workload).

## Sharing the statistics

`tools/ab-stats.js` has no Node or browser dependencies. A runner supplies `sample(side)`, which takes one
fresh throughput sample of side `"a"` or `"b"`; `sampleUntilResolved` alternates the sides, stops and
summarises, and `describeComparison` prints the line. The browser A/B supplies a `sample` that opens a fresh
page on that side's build and reads the `?benchmark` result, and so reports the same result in the same shape.
`tools/ab-sides.js` holds what else the two share: checking out a ref with its packages, the workloads each side
has, and the options for when to stop. A caller that allows fewer than `FewestDecisivePairs` (8) pairs can get a
result with no interval: its bounds are 0 and `Infinity` (`null` in JSON), and so is the minimum detectable change.
