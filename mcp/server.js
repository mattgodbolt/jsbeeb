/**
 * jsbeeb MCP Server
 *
 * Exposes a headless BBC Micro emulator to AI assistants via the Model
 * Context Protocol.  Start it with:
 *
 *   node mcp/server.js
 *
 * and connect it from Claude Desktop, Cursor, or any MCP-compatible client
 * by adding it to mcp_servers in the client config.
 *
 * Capabilities:
 *   - Boot a BBC B or BBC Master
 *   - Load and run BBC BASIC programs
 *   - Type at the keyboard
 *   - Capture text output
 *   - Take screenshots (PNG, base64-encoded)
 *   - Read/write memory
 *   - Inspect CPU registers
 *   - Persistent sessions (multiple machines at once)
 *   - One-shot `run_basic` convenience tool (no session management needed)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MachineSession } from "./machine-session.js";

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId → MachineSession

function requireSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`No session with id "${sessionId}". Call create_machine first.`);
    return s;
}

function newSessionId() {
    return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
    name: "jsbeeb",
    version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: create_machine
// ---------------------------------------------------------------------------

server.tool(
    "create_machine",
    "Boot a BBC Micro emulator and return a session ID for use with all other tools. " +
        "The machine runs until the BASIC prompt before this call returns.",
    {
        model: z
            .enum(["B-DFS1.2", "B-DFS2.26", "Master", "Master-MOS3.20"])
            .default("B-DFS1.2")
            .describe("BBC Micro model to emulate"),
        boot_timeout_secs: z.number().default(30).describe("Max seconds of emulated time to wait for the boot prompt"),
    },
    async ({ model, boot_timeout_secs }) => {
        const session = new MachineSession(model);
        await session.initialise();
        const bootOutput = await session.boot(boot_timeout_secs);
        const id = newSessionId();
        sessions.set(id, session);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        session_id: id,
                        model,
                        boot_output: bootOutput,
                    }),
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: destroy_machine
// ---------------------------------------------------------------------------

server.tool(
    "destroy_machine",
    "Destroy a BBC Micro session and free its resources.",
    { session_id: z.string().describe("Session ID from create_machine") },
    async ({ session_id }) => {
        const s = sessions.get(session_id);
        if (s) {
            s.destroy();
            sessions.delete(session_id);
        }
        return { content: [{ type: "text", text: "Session destroyed." }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: load_basic
// ---------------------------------------------------------------------------

server.tool(
    "load_basic",
    "Tokenise BBC BASIC source code and load it into the emulator's PAGE memory, " +
        "exactly as if you had typed it in and saved it. Does NOT run the program.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        source: z.string().describe("BBC BASIC source code (plain text, BBC dialect)"),
    },
    async ({ session_id, source }) => {
        const session = requireSession(session_id);
        await session.loadBasic(source);
        return { content: [{ type: "text", text: "BASIC program loaded into PAGE." }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: type_input
// ---------------------------------------------------------------------------

server.tool(
    "type_input",
    "Type text at the current keyboard prompt (simulates key presses). " +
        "A newline/RETURN is automatically sent after the text. " +
        "Use run_until_prompt after this to collect output.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        text: z.string().describe("Text to type (e.g. 'RUN' or '10 PRINT\"HELLO\"')"),
    },
    async ({ session_id, text }) => {
        const session = requireSession(session_id);
        await session.type(text);
        return { content: [{ type: "text", text: `Typed: ${text}` }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: run_until_prompt
// ---------------------------------------------------------------------------

server.tool(
    "run_until_prompt",
    "Run the emulator until it returns to a keyboard input prompt (e.g. the BASIC prompt after RUN completes). " +
        "Returns all text output that was written to the screen since the last call.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        timeout_secs: z.number().default(60).describe("Max emulated seconds to run before giving up"),
    },
    async ({ session_id, timeout_secs }) => {
        const session = requireSession(session_id);
        const output = await session.runUntilPrompt(timeout_secs);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(output),
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: screenshot
// ---------------------------------------------------------------------------

server.tool(
    "screenshot",
    "Capture the current BBC Micro screen as a PNG image. " +
        "Returns a base64-encoded PNG of the full 1024×625 emulated display. " +
        "Tip: call run_until_prompt first to let the screen settle.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        active_only: z
            .boolean()
            .default(true)
            .describe("If true, crop to the active display area and apply 2× pixel scaling for clarity"),
    },
    async ({ session_id, active_only }) => {
        const session = requireSession(session_id);
        const png = active_only ? await session.screenshotActive() : await session.screenshot();
        return {
            content: [
                {
                    type: "image",
                    data: png.toString("base64"),
                    mimeType: "image/png",
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: read_memory
// ---------------------------------------------------------------------------

server.tool(
    "read_memory",
    "Read bytes from the BBC Micro's memory map. " + "Returns an array of decimal byte values plus a hex dump.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        address: z.number().int().min(0).max(0xffff).describe("Start address (0–65535)"),
        length: z.number().int().min(1).max(256).default(16).describe("Number of bytes to read (max 256)"),
    },
    async ({ session_id, address, length }) => {
        const session = requireSession(session_id);
        const bytes = session.readMemory(address, length);
        const hexDump = formatHexDump(address, bytes);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        address,
                        addressHex: `0x${address.toString(16).toUpperCase()}`,
                        bytes,
                        hexDump,
                    }),
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: write_memory
// ---------------------------------------------------------------------------

server.tool(
    "write_memory",
    "Write bytes into the BBC Micro's memory. " +
        "Useful for poking machine code, modifying variables, or patching running programs.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        address: z.number().int().min(0).max(0xffff).describe("Start address (0–65535)"),
        bytes: z.array(z.number().int().min(0).max(255)).describe("Array of byte values to write"),
    },
    async ({ session_id, address, bytes }) => {
        const session = requireSession(session_id);
        session.writeMemory(address, bytes);
        return {
            content: [
                {
                    type: "text",
                    text: `Wrote ${bytes.length} byte(s) at 0x${address.toString(16).toUpperCase()}.`,
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: read_registers
// ---------------------------------------------------------------------------

server.tool(
    "read_registers",
    "Read the current 6502 CPU register state (PC, A, X, Y, stack pointer, processor status).",
    { session_id: z.string().describe("Session ID from create_machine") },
    async ({ session_id }) => {
        const session = requireSession(session_id);
        const regs = session.registers();
        return { content: [{ type: "text", text: JSON.stringify(regs) }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: run_for_cycles
// ---------------------------------------------------------------------------

server.tool(
    "run_for_cycles",
    "Run the emulator for an exact number of 2MHz CPU cycles. " +
        "Useful for precise timing, or just to advance the clock a bit between interactions.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        cycles: z.number().int().min(1).describe("Number of 2MHz CPU cycles to execute"),
    },
    async ({ session_id, cycles }) => {
        const session = requireSession(session_id);
        await session.runFor(cycles);
        const output = session.drainOutput();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ cycles_run: cycles, output }),
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: run_basic  (convenience: one-shot, no session management needed)
// ---------------------------------------------------------------------------

server.tool(
    "run_basic",
    "One-shot convenience tool: boot a BBC Micro, load a BASIC program, run it, " +
        "return all text output and a screenshot, then destroy the session. " +
        "Perfect for quickly trying out ideas without managing sessions.",
    {
        source: z.string().describe("BBC BASIC source code to run"),
        model: z.enum(["B-DFS1.2", "Master"]).default("B-DFS1.2").describe("BBC Micro model"),
        timeout_secs: z.number().default(30).describe("Max emulated seconds to allow the program to run"),
        screenshot: z.boolean().default(true).describe("Include a screenshot of the final screen state"),
    },
    async ({ source, model, timeout_secs, screenshot: wantScreenshot }) => {
        const session = new MachineSession(model);
        try {
            await session.initialise();
            await session.boot(30);
            await session.loadBasic(source);
            await session.type("RUN");
            const output = await session.runUntilPrompt(timeout_secs);

            const result = { output };

            if (wantScreenshot) {
                const png = await session.screenshotActive();
                return {
                    content: [
                        { type: "text", text: JSON.stringify(result) },
                        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
                    ],
                };
            }

            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } finally {
            session.destroy();
        }
    },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHexDump(startAddr, bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
        const chunk = bytes.slice(i, i + 16);
        const addr = (startAddr + i).toString(16).toUpperCase().padStart(4, "0");
        const hex = chunk.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
        const ascii = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
        lines.push(`${addr}  ${hex.padEnd(47)}  |${ascii}|`);
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error("Failed to start jsbeeb MCP server:", err);
    process.exit(1);
});
