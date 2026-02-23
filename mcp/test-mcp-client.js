/**
 * End-to-end MCP client test for the jsbeeb MCP server.
 * Starts the server as a subprocess and talks to it over the real stdio transport.
 *
 * Run with: node mcp/test-mcp-client.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function ok(label, value) {
    if (value) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        failed++;
    }
}

function textContent(result) {
    return result.content.find((c) => c.type === "text")?.text ?? "";
}

function imageContent(result) {
    return result.content.find((c) => c.type === "image");
}

async function callTool(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`Tool ${name} returned error: ${JSON.stringify(result.content)}`);
    return result;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
    console.log("Starting jsbeeb MCP server...");
    const transport = new StdioClientTransport({
        command: "node",
        args: [resolve(__dirname, "server.js")],
        cwd: resolve(__dirname, ".."),
    });

    const client = new Client({ name: "jsbeeb-test-client", version: "0.0.1" });
    await client.connect(transport);
    console.log("Connected.\n");

    // --- List tools ---
    console.log("--- list tools ---");
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);
    console.log("Tools:", toolNames.join(", "));
    ok("has create_machine", toolNames.includes("create_machine"));
    ok("has run_basic", toolNames.includes("run_basic"));
    ok("has load_disc", toolNames.includes("load_disc"));
    ok("has screenshot", toolNames.includes("screenshot"));
    ok("has read_memory", toolNames.includes("read_memory"));
    ok("has write_memory", toolNames.includes("write_memory"));
    ok("has read_registers", toolNames.includes("read_registers"));

    // --- One-shot run_basic ---
    console.log("\n--- run_basic (one-shot) ---");
    const rb = await callTool(client, "run_basic", {
        source: '10 PRINT "MCP WORKS"\n20 PRINT 6*7\n',
        screenshot: true,
    });
    const rbText = textContent(rb);
    const rbParsed = JSON.parse(rbText);
    console.log("screenText:", JSON.stringify(rbParsed.output.screenText));
    ok("output contains MCP WORKS", rbParsed.output.screenText.includes("MCP WORKS"));
    ok("output contains 42", rbParsed.output.screenText.includes("42"));
    const rbImg = imageContent(rb);
    ok("got a screenshot image", !!rbImg);
    ok("image is PNG (base64)", rbImg?.data?.length > 100);
    if (rbImg) {
        writeFileSync("/home/molty/.openclaw/workspace/mcp-test-screenshot.png", Buffer.from(rbImg.data, "base64"));
        console.log("  Screenshot saved.");
    }

    // --- Session-based workflow ---
    console.log("\n--- session workflow ---");
    const createResult = await callTool(client, "create_machine", { model: "B-DFS1.2" });
    const { session_id, boot_output } = JSON.parse(textContent(createResult));
    console.log("Session:", session_id);
    console.log("Boot text:", JSON.stringify(boot_output.screenText));
    ok("got session_id", !!session_id);
    ok("boot output has BBC Computer", boot_output.screenText.includes("BBC Computer"));
    ok("boot output has BASIC", boot_output.screenText.includes("BASIC"));

    // load_basic
    await callTool(client, "load_basic", {
        session_id,
        source: "10 FOR I=1 TO 3\n20 PRINT I*I\n30 NEXT I\n",
    });

    // type + run
    await callTool(client, "type_input", { session_id, text: "RUN" });
    const runResult = await callTool(client, "run_until_prompt", { session_id });
    const runOutput = JSON.parse(textContent(runResult));
    console.log("Run output:", JSON.stringify(runOutput.screenText));
    ok("output has 1", runOutput.screenText.includes("1"));
    ok("output has 4", runOutput.screenText.includes("4"));
    ok("output has 9", runOutput.screenText.includes("9"));

    // read_memory (zero page)
    const memResult = await callTool(client, "read_memory", { session_id, address: 0, length: 16 });
    const mem = JSON.parse(textContent(memResult));
    ok("got 16 bytes", mem.bytes.length === 16);
    ok("has hex dump", mem.hexDump.includes("0000"));

    // write + read back
    await callTool(client, "write_memory", { session_id, address: 0x700, bytes: [0xde, 0xad, 0xbe, 0xef] });
    const mem2 = await callTool(client, "read_memory", { session_id, address: 0x700, length: 4 });
    const mem2data = JSON.parse(textContent(mem2));
    ok("write_memory round-trips", JSON.stringify(mem2data.bytes) === JSON.stringify([0xde, 0xad, 0xbe, 0xef]));

    // read_registers
    const regsResult = await callTool(client, "read_registers", { session_id });
    const regs = JSON.parse(textContent(regsResult));
    ok("has PC register", typeof regs.pc === "number");
    ok("has pcHex", regs.pcHex.startsWith("0x"));

    // screenshot
    const ssResult = await callTool(client, "screenshot", { session_id, active_only: true });
    const ssImg = imageContent(ssResult);
    ok("screenshot returns image", !!ssImg);
    ok("screenshot is base64 PNG", ssImg?.data?.length > 100);

    // load_disc
    const discPath = resolve(__dirname, "examples/hello.ssd");
    const ldResult = await callTool(client, "load_disc", { session_id, image_path: discPath });
    ok("load_disc succeeds", textContent(ldResult).includes("hello.ssd"));

    await callTool(client, "type_input", { session_id, text: "*RUN hello" });
    const discRun = await callTool(client, "run_until_prompt", { session_id });
    const discOutput = JSON.parse(textContent(discRun));
    console.log("Disc run output:", JSON.stringify(discOutput.screenText));
    ok("disc program output correct", discOutput.screenText.includes("HELLO FROM BEEBASM"));

    // destroy
    const destroyResult = await callTool(client, "destroy_machine", { session_id });
    ok("destroy succeeds", textContent(destroyResult).includes("destroyed"));

    // --- Results ---
    console.log(`\n${"─".repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);

    await client.close();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
});
