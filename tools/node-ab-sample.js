#!/usr/bin/env node
// One sample for tools/node-ab.js, in a fresh process: restore a workload from one side's checkout, warm up,
// then time tick-sized execute() calls. The result goes back over the IPC channel, so a --trace-deopt log
// can have stdout to itself.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { sampleWorkload } from "./ab-sample.js";

async function main() {
    const { values } = parseArgs({
        options: {
            root: { type: "string" },
            workload: { type: "string" },
            "fake-video": { type: "boolean", default: false },
            "warmup-secs": { type: "string" },
            "measure-secs": { type: "string" },
        },
    });
    const machineModule = pathToFileURL(path.join(values.root, "src", "benchmark-machine.js")).href;
    const { benchmarkMachine } = await import(machineModule);
    return sampleWorkload(benchmarkMachine, {
        workload: values.workload,
        fakeVideo: values["fake-video"],
        warmupSecs: Number(values["warmup-secs"]),
        measureSecs: Number(values["measure-secs"]),
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (result) => process.send({ result }, () => process.exit(0)),
        (error) => process.send({ error: error.stack ?? String(error) }, () => process.exit(1)),
    );
}
