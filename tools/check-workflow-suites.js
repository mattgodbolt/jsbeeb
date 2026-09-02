#!/usr/bin/env node
/**
 * Fails if package.json has a test:* script that the CI workflow never runs.
 * The workflow runs each suite as its own step (for the job summary), so a new
 * suite has to be wired in by hand; this is the check that it was.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WorkflowPath = ".github/workflows/test-and-deploy.yml";

export function suitesMissingFrom(scripts, workflowText) {
    return Object.keys(scripts)
        .filter((name) => name.startsWith("test:"))
        .filter((name) => !workflowText.includes(`npm run ${name}`));
}

function main() {
    const { scripts } = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const missing = suitesMissingFrom(scripts, fs.readFileSync(WorkflowPath, "utf8"));
    if (missing.length === 0) return 0;
    console.error(`${WorkflowPath} never runs: ${missing.join(", ")}`);
    return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main());
}
