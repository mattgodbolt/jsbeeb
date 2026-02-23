/**
 * BeebAsm integration example:
 *   1. Boot a BBC B
 *   2. Load hello.ssd into drive 0
 *   3. Run the assembled machine code with *RUN hello
 *   4. Capture text output + screenshot
 *
 * Run with: node mcp/examples/beebasm-example.js
 */

import { MachineSession } from "../machine-session.js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISC_PATH = resolve(__dirname, "hello.ssd");

async function main() {
    const session = new MachineSession("B-DFS1.2");
    await session.initialise();

    console.log("Booting...");
    await session.boot(30);

    console.log("Loading disc image:", DISC_PATH);
    await session.loadDisc(DISC_PATH);

    console.log("Running *RUN hello...");
    await session.type("*RUN hello\r");
    const result = await session.runUntilPrompt(10);

    console.log("\nCaptured output:");
    console.log(result.screenText);

    const png = await session.screenshotActive({ scale: 2 });
    const outPath = resolve(__dirname, "beebasm-result.png");
    writeFileSync(outPath, png);
    console.log("\nScreenshot saved to", outPath);

    session.destroy();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
