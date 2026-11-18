# VDFS

VDFS is a filing system whose files are the host's: a folder on this computer is the BBC's `$`, its files are the
BBC's files, and what the BBC saves is in the folder. It is the same idea as b-em's VDFS and MMFS on a Pi, with a
host that is jsbeeb.

(The host that does the work is in later parts of the stack; this describes the design as a whole.)

It is a sideways ROM (`public/roms/vdfs.rom`, from `roms-src/vdfs`) and a device the ROM talks to. The ROM is the OS's
side of it: it takes over the filing system vectors and forwards every call. The code is in:

- `src/vdfs-protocol.js`: the device in FRED, and the responses the ROM reads (`VdfsPorts`, `Response`)
- `src/vdfs-channels.js`: the open files; `src/vdfs-guest-memory.js`: the 6502's memory as the host may touch it
- `src/vdfs-names.js`: the names the BBC can give a file, and how it spells a path; `src/vdfs-errors.js`: the errors
- `src/vdfs-fs-store.js`: a folder in Node as a store; `src/vdfs-inf.js`: the `.inf` files and the host names both
  stores share

## The ROM and the host

The ROM's code is about 400 bytes, in a 16K image like any other ROM's. It is jsbeeb's own, written here, and under
jsbeeb's licence. It holds no state and no text, and does no
parsing; the host parses `*` commands, makes the `*CAT` listing and decides what is an error. The ROM hands over a call,
waits for it, and does what it is told.

### The ports

Sixteen bytes in FRED, `&FC60` to `&FC6F`, ten of them used. These are not an Acorn allocation, they are jsbeeb's. They
are what a board on the 1MHz bus could be: the 6502 pokes its arguments in, pokes a go code, waits, and reads the
results out. Nothing here needs the host to see the CPU.

| Offset | Name   | Write                                                 | Read                                                                             |
| ------ | ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0      | GO     | The call's number, which starts the call              | Status: bit 7 busy, bit 6 ops for the ROM to carry out, bit 0 the carry returned |
| 1      | A in   | A as the caller had it                                |                                                                                  |
| 2      | X in   | X as the caller had it                                |                                                                                  |
| 3      | Y in   | Y as the caller had it                                |                                                                                  |
| 4      | A out  |                                                       | The A the call returns, which frees the response                                 |
| 5      | X out  |                                                       | The X the call returns                                                           |
| 6      | Y out  |                                                       | The Y the call returns                                                           |
| 7      | STREAM | Chooses the response that DATA and the results are of | The response of the last call                                                    |
| 8      | DATA   |                                                       | The next byte of the ops of the chosen response                                  |
| 9      | ID     |                                                       | `&56`                                                                            |

None of these calls takes the flags as an input, and carry is the only flag one returns, so the ROM neither pokes nor
loads them. It never changes I or D, which the caller's flags keep. N, Z and V come back as whatever the last
instructions left, which the OS does not promise anything about for these calls.

The ROM reads ID before it forwards a service call, and hands the call back to the OS untouched if there is no host.
That is very defensive: jsbeeb fits the ROM only with a host, but `rom=vdfs.rom` or a snapshot can put it in a machine
that has none, and it would crash there.

### Calls

Calls 1 to 7 are the filing system's vectors, with the A, X and Y the OS gave them; call 0 is the ROM's
service entry, with A the service number, X the ROM's slot and Y the parameter. The ROM forwards services 4 (command),
9 (help) and &12 (filing system selected). The numbers are in `roms-src/vdfs/contract.6502`, and
`tests/unit/test-vdfs-protocol.js` fails if `src/vdfs-protocol.js` has different ones.

| Call | Meaning |
| ---- | ------- |
| 0    | Service |
| 1    | FILEV   |
| 2    | ARGSV   |
| 3    | BGETV   |
| 4    | BPUTV   |
| 5    | GBPBV   |
| 6    | FINDV   |
| 7    | FSCV    |

### Waiting

A call may take as long as the store does. After writing GO the ROM reads it until bit 7 is clear, with
`BIT PortGo : BMI wait`, and the 6502 goes on running, interrupts and all, as it would waiting on a disc. A call
that uses the store is always busy when it is first looked at, since the store answers on a later turn of the event
loop, however quick it is.

The host does what the call needs in memory, and writes the answer, only once its store has answered. A break while a
call is waiting ends the call: its answer is not given, and it does not go on to change a machine that has restarted.
A call that does not use the store, such as `OSBGET`, `OSBPUT`, the file pointer and extent, or a check for the end of a
file, is not busy at all, unless a folder change is being waited for or a file is still being written back, when every call waits.

Some things follow from that:

- A call made while files from before a break are still being written waits for them, so that it sees them.
- The filing system is not re-entrant, as the DFS is not: a call made from an interrupt while one is waiting ends the
  one that was waiting, which then returns nothing.
- A call that a break has ended may still have a request on its way to the store, and its result will not be used. An
  `OSFIND` for output that a break catches at the wrong moment may leave an empty file behind.
- A store that never answers leaves the BBC waiting until BREAK. There is no timeout.
- Cycle counts depend on how long the store takes, so a replay cannot repeat a VDFS call. Step back, Call stack, trace
  and the other searches that replay the run are not available while a folder is served, as with Econet. A replay the
  Rewind panel makes, for a thumbnail or to land on a snapshot, runs the ROM against a host that is idle, and does not
  reach the folder.
- A snapshot holds the device the ROM was using, so one restored partway through a call carries on exactly, but not the
  open files, the current directory or which filing system was selected, which a restore puts back as a break does. A
  call that was waiting for the store when the snapshot was taken ends with "Disc changed" when it is restored.

### The response

When the call is no longer busy its response has two parts. The registers it returns are read from the A out, X out and
Y out ports and bit 0 of the status. They are the response's own, so a call made while the ROM is carrying out ops does
not change them. The ops, if bit 6 of the status says there are any, are a stream: a list of things for the ROM to do,
ending in `Done`. The ROM reads STREAM for the response's number, then reads DATA for each byte, writing the number back
to STREAM before each read that could follow a call it made (the OS can call the filing system again while the ROM
prints, with `*SPOOL`). Responses are one per call, so a nested call does not disturb the one being read.

A call that only returns registers has no ops, and the ROM reads its registers straight away. Reading A out is the last
thing the ROM does with a response, and frees it.

| Op  | Name  | Bytes after it                             | The ROM                                                             |
| --- | ----- | ------------------------------------------ | ------------------------------------------------------------------- |
| 0   | Done  | none                                       | has no more ops, and returns the registers to the caller            |
| 1   | Print | text, 0                                    | writes it with `OSASCI`                                             |
| 2   | Error | error number, text, 0                      | raises it, as a `BRK` built in page 1; it does not return           |
| 3   | Exec  | high byte, low byte, of the address less 1 | pages in the language ROM and jumps to the address; does not return |
| 4   | Claim | none                                       | takes over the filing system vectors, and carries on                |

A response that ends in an error or an exec has no registers, since the ROM does not come back for them. The host
answers every failure of its own as an error, so a bug in the host is a message on the BBC and not an exception in the
emulator.

Claiming the vectors is the filing system's selection as the DFS does it: tell the one in use with `FSCV` call 6,
write the seven vectors to the OS's extended vector entries, put the extended vector table's entries in place
(found with `OSBYTE &A8`), and issue service call &F.

### The store

The host is given an object with these calls, each returning a promise, and the text of what it throws is what the BBC's
"Disc fault" says. A store may have more than this for its page: `FsStore.check()`. `src/vdfs-fs-store.js` is the one for a folder in Node.
The names it is given and
gives are the BBC's; matching them without regard to case, and keeping the addresses and lock, is its work.

| Call                       | Gives                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `find(directory, name)`    | what is there, or null: `{name, isDirectory, size, load, exec, locked}`                                                |
| `list(directory)`          | `{entries, skipped}`: what is in it, and the names of what the BBC cannot be given; null if there is no such directory |
| `read(path)`               | the file's bytes                                                                                                       |
| `writeFile(path, details)` | makes or replaces a file: `{data, load, exec, locked}`                                                                 |
| `setInfo(path, changes)`   | changes any of `load`, `exec` and `locked`, and leaves what the file holds                                             |
| `makeDirectory(path)`      |                                                                                                                        |
| `remove(path)`             | a file or an empty directory                                                                                           |

## Building the ROM

The ROM is assembled with [Baron](https://github.com/waitingforvsync/baron) and checked in, so running jsbeeb does not
need it, and the ROM is fitted and loaded only to a machine that has VDFS. Rebuilding it needs Baron on the path, or in
`$BARON`:

```sh
npm run build:vdfs-rom
npm run check:vdfs-rom
```

The check is for CI too (`.github/workflows/vdfs-rom.yml`, which builds the Baron release it names), and says whether
the checked-in ROM is what the source gives.
