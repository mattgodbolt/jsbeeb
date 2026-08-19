// Renders each test page under jsbeeb and writes t1.png to t8.png into the
// refs directory beside this script, for comparison against a photograph of
// the same page on real hardware.
//
//   node tests/hardware/teletext/capture-refs.js
//
// The flash phase is not controlled here, so T2 and T6 may be captured in
// either phase; run it again if you want the other one.

import { mkdirSync, writeFileSync } from "fs";
import path from "node:path";
import { Pages, RefDir, renderPage } from "./render-page.js";

async function main() {
    mkdirSync(RefDir, { recursive: true });

    for (const page of Pages) {
        const file = path.join(RefDir, `${page.toLowerCase()}.png`);
        writeFileSync(file, await renderPage(page));
        console.log(`wrote ${file}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
