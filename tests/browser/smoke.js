// Boots the built page in headless Chrome and exercises the things unit tests
// cannot see: construction order, element ids, Bootstrap, the console surface.
// Talks to Chrome over the DevTools protocol with Node's own WebSocket.
//
//   npm run test:smoke       build, serve dist/ and run every check
//   node tests/browser/smoke.js --url http://localhost:5173/   against a running server
//   node tests/browser/smoke.js --only modal                    checks whose name matches

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const Args = parseArgs(process.argv.slice(2));
const PreviewHost = "127.0.0.1";
const PreviewPort = 5199;
const DebugPort = 9229 + Math.floor(Math.random() * 1000);
const ChromeCandidates = [
    process.env.CHROME_PATH,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
];
const ScreenBase = 0x7c00;
const ScreenBytes = 1000;
const BootTimeoutMs = 30000;
const StepTimeoutMs = 10000;
const ServerTimeoutMs = 30000;
const KeyHoldMs = 120;
const ConsoleSurface = [
    "processor",
    "video",
    "soundChip",
    "go",
    "stop",
    "hd",
    "m7dump",
    "benchmarkCpu",
    "profileCpu",
    "benchmarkVideo",
    "profileVideo",
];

function parseArgs(argv) {
    const args = { url: null, only: null, keep: false };
    const value = (i) => {
        if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; ++i) {
        if (argv[i] === "--url") args.url = value(i++);
        else if (argv[i] === "--only") args.only = value(i++);
        else if (argv[i] === "--keep") args.keep = true;
        else throw new Error(`Unknown argument ${argv[i]}`);
    }
    return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(description, probe, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await probe();
        if (last) return last;
        await sleep(100);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

async function startPreview() {
    // vite's own entry point, not npx: a kill has to reach the server itself.
    const vite = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    // Bound by address, not "localhost": on a runner that resolves to ::1 first.
    const child = spawn(
        process.execPath,
        [vite, "preview", "--host", PreviewHost, "--port", `${PreviewPort}`, "--strictPort"],
        { stdio: "ignore" },
    );
    const url = `http://${PreviewHost}:${PreviewPort}/`;
    await waitUntil(
        "the preview server",
        () =>
            fetch(url).then(
                (response) => response.ok,
                () => false,
            ),
        ServerTimeoutMs,
    );
    return { url, stop: () => child.kill() };
}

async function startChrome(width) {
    const args = [
        "--headless=new",
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--autoplay-policy=no-user-gesture-required",
        `--remote-debugging-port=${DebugPort}`,
        `--window-size=${width},900`,
        "about:blank",
    ];
    const candidates = ChromeCandidates.filter(Boolean);
    for (const candidate of candidates) {
        const child = spawn(candidate, args, { stdio: "ignore" });
        // A candidate that is not there fails to spawn; one that is there but
        // cannot run exits straight away. Either way, try the next.
        const gone = new Promise((resolve) => {
            child.once("error", () => resolve(true));
            child.once("exit", () => resolve(true));
        });
        const target = await Promise.race([gone, debugTarget()]);
        if (target !== true) return { child, target };
    }
    throw new Error(`No Chrome would start; tried ${candidates.join(", ")}`);
}

/** The page target of the Chrome listening on the debug port, once it is. */
function debugTarget() {
    return waitUntil(
        "Chrome's debugging port",
        async () => {
            try {
                const list = await (await fetch(`http://127.0.0.1:${DebugPort}/json/list`)).json();
                return list.find((t) => t.type === "page");
            } catch (_e) {
                return null;
            }
        },
        StepTimeoutMs,
    );
}

class Page {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        this.problems = [];
        ws.onmessage = (message) => this.onMessage(JSON.parse(message.data));
    }

    static async connect(target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });
        const page = new Page(ws);
        await page.send("Page.enable");
        await page.send("Runtime.enable");
        await page.send("Log.enable");
        return page;
    }

    onMessage(message) {
        if (message.id && this.pending.has(message.id)) {
            this.pending.get(message.id)(message);
            this.pending.delete(message.id);
        } else if (message.method === "Runtime.exceptionThrown") {
            const details = message.params.exceptionDetails;
            this.problems.push(`exception: ${details.exception?.description ?? details.text}`);
        } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
            this.problems.push(`console error: ${message.params.entry.text}`);
        } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
            const text = message.params.args.map((arg) => arg.value ?? arg.description).join(" ");
            this.problems.push(`console.error: ${text}`);
        }
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending.set(id, (message) =>
                message.error ? reject(new Error(message.error.message)) : resolve(message.result),
            );
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression) {
        const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) {
            const details = result.exceptionDetails;
            throw new Error(`evaluate failed: ${details.exception?.description ?? details.text}`);
        }
        return result.result.value;
    }

    async goto(url) {
        await this.send("Page.navigate", { url });
        // Anything logged while the previous page was unloading is not this page's.
        this.problems.length = 0;
        await waitUntil("the page to load", () => this.evaluate(`document.readyState === "complete"`), StepTimeoutMs);
    }

    /** Mode 7 screen memory as text, which is what the machine shows at the prompt. */
    screenText() {
        return this.evaluate(
            `Array.from({ length: ${ScreenBytes} }, (_, i) => String.fromCharCode(processor.readmem(${ScreenBase} + i) & 0x7f)).join("")`,
        );
    }

    async waitForScreenText(text, timeoutMs = BootTimeoutMs) {
        return waitUntil(`"${text}" on the screen`, async () => (await this.screenText()).includes(text), timeoutMs);
    }

    async cycles() {
        return this.evaluate("processor.currentCycles");
    }

    click(selector) {
        return this.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error("No element matches " + ${JSON.stringify(selector)});
            el.click();
            return true;
        })()`);
    }

    async pressKey(key, code, keyCode) {
        const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
        await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
        // Held long enough for the OS to scan the matrix and see it down.
        await sleep(KeyHoldMs);
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    }

    takeProblems() {
        const problems = this.problems.slice();
        this.problems.length = 0;
        return problems;
    }
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

check("boots to the BASIC prompt with a working console surface", async (page, base) => {
    await page.goto(base);
    await page.waitForScreenText("BASIC");
    await page.waitForScreenText(">");
    for (const name of ConsoleSurface) {
        const type = await page.evaluate(`typeof window[${JSON.stringify(name)}]`);
        if (type === "undefined") throw new Error(`window.${name} is missing`);
    }
    const byte = await page.evaluate("processor.readmem(0)");
    if (typeof byte !== "number") throw new Error(`processor.readmem(0) gave ${byte}`);
});

check("typing at the keyboard reaches the machine", async (page, base) => {
    await page.goto(base);
    await page.waitForScreenText(">");
    await page.pressKey("a", "KeyA", 65);
    await page.waitForScreenText(">A", StepTimeoutMs);
});

check("a disc named in the URL is loaded and autobooted", async (page, base) => {
    await page.goto(`${base}?disc=elite.ssd&autoboot`);
    await waitUntil(
        "the disc to be in drive 0",
        () => page.evaluate(`processor.fdc.drives[0].disc?.name === "elite.ssd"`),
        BootTimeoutMs,
    );
    // Elite's loader leaves mode 7, so the prompt text goes away.
    await waitUntil("the disc to boot", async () => !(await page.screenText()).includes("BASIC"), BootTimeoutMs);
});

check("a modal pauses the emulator and closing it resumes", async (page, base) => {
    await page.goto(base);
    await page.waitForScreenText(">");
    await page.click('a[data-bs-target="#configuration"]');
    await waitUntil(
        "the pause button to be disabled",
        () => page.evaluate(`document.getElementById("debug-pause").disabled`),
        StepTimeoutMs,
    );
    // Bootstrap ignores a hide while its show transition is still running.
    await waitUntil(
        "the modal to finish appearing",
        () =>
            page.evaluate(
                `(() => { const el = document.getElementById("configuration"); return el.classList.contains("show") && getComputedStyle(el).opacity === "1"; })()`,
            ),
        StepTimeoutMs,
    );
    const before = await page.cycles();
    await sleep(300);
    const during = await page.cycles();
    if (during !== before) throw new Error(`Emulator ran ${during - before} cycles while a modal was up`);
    await page.click("#configuration .btn-close");
    await waitUntil(
        "the pause button to be enabled",
        () => page.evaluate(`!document.getElementById("debug-pause").disabled`),
        StepTimeoutMs,
    );
    await waitUntil("the emulator to run again", async () => (await page.cycles()) > during, StepTimeoutMs);
});

check("every display mode and sound output on the bar can be picked", async (page, base) => {
    await page.goto(base);
    await page.waitForScreenText(">");
    const modes = await page.evaluate(
        `[...document.querySelectorAll("#display-mode [data-mode]")].map((b) => b.dataset.mode)`,
    );
    const outputs = await page.evaluate(
        `[...document.querySelectorAll("#audio-output [data-output]")].map((b) => b.dataset.output)`,
    );
    if (!modes.length || !outputs.length) throw new Error("The quick settings bar has no buttons");
    for (const mode of modes) {
        await page.click(`#display-mode [data-mode="${mode}"]`);
        await sleep(200);
        const active = await page.evaluate(`document.querySelector("#display-mode .active")?.dataset.mode`);
        if (active !== mode) throw new Error(`Picked display mode ${mode} but ${active} is active`);
    }
    for (const output of outputs) {
        await page.click(`#audio-output [data-output="${output}"]`);
        await sleep(100);
        const active = await page.evaluate(`document.querySelector("#audio-output .active")?.dataset.output`);
        if (active !== output) throw new Error(`Picked sound output ${output} but ${active} is active`);
    }
    await page.waitForScreenText(">", StepTimeoutMs);
});

check("a saved state can be loaded back", async (page, base) => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "jsbeeb-smoke-"));
    try {
        await page.goto(base);
        await page.waitForScreenText(">");
        await page.pressKey("a", "KeyA", 65);
        await page.waitForScreenText(">A", StepTimeoutMs);
        // Headless Chrome's download path is not the thing under test, so
        // catch the download at the anchor and read the blob back instead.
        await page.evaluate(`(() => {
            const realClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () {
                if (!this.download) return realClick.call(this);
                const name = this.download;
                window.smokeDownload = fetch(this.href)
                    .then((response) => response.blob())
                    .then((blob) => new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve({ name, base64: reader.result.split(",")[1] });
                        reader.readAsDataURL(blob);
                    }));
            };
        })()`);
        await page.click("#save-state");
        const { name, base64 } = await waitUntil(
            "the state file to be produced",
            () => page.evaluate("window.smokeDownload"),
            StepTimeoutMs,
        );
        const saved = path.join(downloads, name);
        fs.writeFileSync(saved, Buffer.from(base64, "base64"));
        await page.pressKey("b", "KeyB", 66);
        await page.waitForScreenText(">AB", StepTimeoutMs);

        const { root } = await page.send("DOM.getDocument");
        const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#load-state" });
        await page.send("DOM.setFileInputFiles", { nodeId, files: [saved] });
        await waitUntil(
            "the saved screen to come back",
            async () => {
                const text = await page.screenText();
                return text.includes(">A") && !text.includes(">AB");
            },
            StepTimeoutMs,
        );
    } finally {
        fs.rmSync(downloads, { recursive: true, force: true });
    }
});

async function main() {
    const server = Args.url ? null : await startPreview();
    const base = Args.url ?? server.url;
    let chrome = null;
    let failures = 0;
    try {
        const started = await startChrome(1400);
        chrome = started.child;
        const page = await Page.connect(started.target);
        const selected = checks.filter((c) => !Args.only || c.name.includes(Args.only));
        for (const { name, run } of selected) {
            try {
                await run(page, base);
                const problems = page.takeProblems();
                if (problems.length) throw new Error(problems.join("\n  "));
                console.log(`ok   ${name}`);
            } catch (error) {
                failures++;
                console.log(`FAIL ${name}\n  ${error.message}`);
                const late = page.takeProblems();
                if (late.length) console.log(`  ${late.join("\n  ")}`);
            }
        }
        if (Args.keep) {
            console.log(`Chrome left running on port ${DebugPort}; base ${base}`);
            await new Promise(() => {});
        }
    } finally {
        chrome?.kill();
        server?.stop();
    }
    process.exit(failures ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
