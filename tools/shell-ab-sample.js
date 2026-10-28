// The entry point of a side's shell bundle (tools/shell-bench.js), which takes one sample in a fresh shell.
import { runSample } from "./shell-host.js";
import { benchmarkMachine } from "jsbeeb-side:benchmark-machine";
import { sampleWorkload } from "./ab-sample.js";

runSample((options) => sampleWorkload(benchmarkMachine, options));
