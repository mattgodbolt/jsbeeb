# jsbeeb MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that
exposes a headless BBC Micro emulator to AI assistants (Claude, Cursor, etc.).

Write a BASIC program, run it, get the text output and a screenshot — all
without opening a browser.

## Quick start

```bash
# Install deps (from the jsbeeb root)
npm install

# Run the server (connects over stdin/stdout — for use by an MCP client)
npm run mcp
```

## Tools

### `run_basic` _(convenience — no session management needed)_

One-shot: boot a BBC Micro, load a BASIC program, run it, return text output
and an optional screenshot, then clean up.

```json
{
  "source": "10 PRINT \"HELLO WORLD\"\n20 GOTO 10",
  "model": "B-DFS1.2",
  "timeout_secs": 10,
  "screenshot": true
}
```

### Session-based tools

For multi-step interaction (debugging, iterative development):

| Tool               | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `create_machine`   | Boot a BBC Micro (B or Master), returns a `session_id`         |
| `destroy_machine`  | Free a session                                                 |
| `load_basic`       | Tokenise + load BBC BASIC source into PAGE                     |
| `type_input`       | Type text at the current keyboard prompt (RETURN is automatic) |
| `run_until_prompt` | Run until BASIC/OS prompt, return captured screen text         |
| `screenshot`       | Capture the current screen as a PNG image                      |
| `read_memory`      | Read bytes from the memory map (with hex dump)                 |
| `write_memory`     | Poke bytes into memory                                         |
| `read_registers`   | Get 6502 CPU registers (PC, A, X, Y, S, P)                     |
| `run_for_cycles`   | Run exactly N 2MHz CPU cycles                                  |

## Connecting to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jsbeeb": {
      "command": "node",
      "args": ["/path/to/jsbeeb/mcp/server.js"]
    }
  }
}
```

## What works

- ✅ BBC BASIC programs (tokenised and loaded directly into memory)
- ✅ Text output capture (position, colour, mode)
- ✅ Screenshots (real Video chip output → PNG via `sharp`)
- ✅ Memory read/write
- ✅ CPU register inspection
- ✅ BBC B and Master models
- ✅ Multiple concurrent sessions

## Known limitations

- **`type_input` character set**: the keyboard simulation handles A–Z, 0–9 and
  a handful of symbols. Some characters (e.g. `#`, `@`, `\`, `^`, `_`) aren't
  yet mapped — patches welcome.
- **Boot text**: the VDU capture hook is installed after the initial boot
  completes, so the OS startup banner isn't captured. Everything after the
  first `>` prompt is captured.
- **No assembler built in**: to run machine code, poke it via `write_memory`
  and `CALL` it from BASIC, or assemble with `*` commands using the BBC's own
  assembler in BASIC.
- **Sound**: the sound chip is silenced (headless mode).
- **Disc images**: `load_disc` works for existing `.ssd`/`.dsd` files in the
  `discs/` directory; creating new disc images from scratch isn't yet exposed.

## Architecture

```
mcp/
  server.js          # MCP server — tool definitions, session store
  machine-session.js # Wraps TestMachine with real Video framebuffer
                     # and accumulated text capture
```

`MachineSession` uses `TestMachine` (from `tests/`) passing a real `Video`
instance via `fake6502`'s `opts.video` override — so the full video chip runs
and writes into a 1024×625 RGBA framebuffer. `sharp` (already in devDeps)
encodes it to PNG on demand.
