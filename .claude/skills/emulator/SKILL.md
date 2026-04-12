---
name: emulator
description: Boot and interact with a headless BBC Micro or Acorn Atom emulator for testing
allowed-tools: Bash, Read
---

# Headless Emulator

Boot a BBC Micro or Acorn Atom emulator and interact with it via typed commands.
Uses `MachineSession` from `src/machine-session.js`.

## Usage

Run Node.js one-liners from the jsbeeb project root:

```javascript
import { MachineSession } from "./src/machine-session.js";

const session = new MachineSession("MODEL_NAME");
await session.initialise();
await session.boot(10);
session.drainOutput(); // clear boot text

await session._machine.type("PRINT 1+1");
await session._machine.runFor(2000000);
console.log(session.drainOutput().screenText);
// "\n\n PRINT 1+1\n        2\n>"

session.destroy();
```

## Text output vs screenshots

**Prefer text output** (`drainOutput().screenText`) -- it's lightweight and easy to parse.
Only use screenshots when you need to verify graphical output (MODE changes, plotting, character rendering).

```javascript
// Text (default, preferred):
const output = session.drainOutput();
console.log(output.screenText);

// Screenshot (only when visual verification needed):
import { writeFileSync } from "fs";
const png = await session.screenshot();
writeFileSync("/tmp/screen.png", png);
// Then use Read tool on /tmp/screen.png to view it
```

## Available models

- **BBC:** `B-DFS1.2`, `B-DFS2.26`, `Master`, `Master-MOS3.20`
- **Atom:** `Atom-Tape`, `Atom-Tape-FP`, `Atom-MMC`, `Atom-DOS`

## Key differences between BBC and Atom

- **Atom BASIC** needs explicit `END` as the last line of programs
- **Atom OS commands** use `*` prefix: `*LOAD`, `*SAVE`, `*CAT`
- Atom runs at 1 MHz (BBC at 2 MHz), so use longer `runFor` values

## Tips

- `runFor(n)` runs n CPU cycles. At 2 MHz (BBC): n/2000000 seconds. At 1 MHz (Atom): n/1000000 seconds.
- `drainOutput()` returns `{ elements, screenText }` and clears the buffer. Call between commands for clean output.
- For multi-line programs, type each line separately with `runFor(500000)` between them.
- `session._machine.readbyte(addr)` / `writebyte(addr, val)` for direct memory access.
- `session.registers()` returns `{ pc, a, x, y, s, p }`.

## Example: Atom program

```javascript
const session = new MachineSession("Atom-Tape");
await session.initialise();
await session.boot(10);
session.drainOutput();

for (const line of ['10PRINT"HELLO"', "20END"]) {
  await session._machine.type(line);
  await session._machine.runFor(500000);
}
session.drainOutput(); // clear line entry echo

await session._machine.type("RUN");
await session._machine.runFor(2000000);
console.log(session.drainOutput().screenText);
// HELLO>

session.destroy();
```
