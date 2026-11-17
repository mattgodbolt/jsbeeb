# VDFS

VDFS is a filing system whose files are the host's: a folder on this computer is the BBC's `$`, its files are the
BBC's files, and what the BBC saves is in the folder. It is the same idea as b-em's VDFS and MMFS on a Pi, with a
host that is jsbeeb.

It is a sideways ROM (`public/roms/vdfs.rom`, from `roms-src/vdfs`) and a device the ROM talks to. The ROM is the OS's
side of it: it takes over the filing system vectors and forwards every call. The host does the work, in:

- `src/vdfs-protocol.js`: the device in FRED, and the responses the ROM reads (`VdfsPorts`, `Response`)
- `src/vdfs-host.js`: what the OS's filing system calls and the commands do (`VdfsHost`)
- `src/vdfs-channels.js`: the open files; `src/vdfs-guest-memory.js`: the 6502's memory as the host may touch it
- `src/vdfs-names.js`: the names the BBC can give a file, and how it spells a path; `src/vdfs-errors.js`: the errors
- `src/vdfs-fs-store.js`: a folder in Node as a store; `src/vdfs-inf.js`: the `.inf` files and the host names both
  stores share
- `src/web/vdfs-folder-store.js`, `vdfs-folder.js`, `vdfs-ui.js`: a folder in a browser as a store, the folder kept
  for the next page, and the menu
- `src/app/app.js` (the IPC handlers, the change of folder, and writing open files as a window closes or the app
  quits), `src/app/vdfs-swap.js`, `src/app/preload.js` and `src/app/electron.js` (the page's side): the desktop app's
  side, which holds the folder in the main process

There is no copy of the folder in memory. The host asks the store for what a call needs as the call is made, and the
ROM waits for the answer, as it would for a disc.

## Using it

In the desktop app, File, Serve VDFS Folder... chooses a folder. If none was being served the page starts again with it,
which fits the ROM, after asking, since the BBC restarts; if one was, the machine goes on, as though the disc had been
swapped: a call that is waiting ends with "Disc changed", what is open is written to the old folder and closed, the
current directory and library go back to the root, and the BBC's next call finds the new folder. Stop Serving VDFS
Folder starts the page again without it, after asking. The folder is the main process's: it answers only the app's own page, and only for the folder the page was told of.
What the page had not yet written when the folder changed is not written to the new one: the page reports it, and so
does the main process for a call that was on its way.

In a browser with the File System Access API (Chrome, Edge and other Chromium browsers; not Firefox or Safari), More,
Serve a folder as VDFS... asks for a folder and starts the page again with it, as the desktop app does for its first
folder. The folder is kept in the browser's IndexedDB, so a page opened with `?vdfs` finds it again. The browser asks
again whether the page may use it in a new session, and only a click can answer; the page shows a notice with an Allow
button when that is so, and until it is answered the BBC gets "Disc fault: The browser has not been told that the VDFS
folder may be used". If the answer was no, the BBC gets a disc fault that says to allow it in the site settings. More,
Stop serving the VDFS folder forgets it. A browser cannot be made to write a file as the page goes, so a program that
has a file open when the tab is closed may lose what it wrote since it last closed or flushed it; the page writes what
is open when it is hidden, which is the best that can be done.

In Node, give `MachineSession` a folder:

```js
const session = new MachineSession("B-DFS1.2", { vdfsFolder: "/path/to/games" });
await session.initialise();
await session.boot();
await session.type("*VDFS");
```

`*VDFS` selects the filing system. Files the BBC writes reach the folder as they are closed, saved or flushed;
`await session.flushVdfs()` is the way to know that open files have, for a test that then looks in the folder.

VDFS is not the filing system a break starts with, because the DFS sits in a higher ROM bank than a fitted ROM can
take and so sees the boot service call first. `*VDFS` does it, and `autotype` can type it.

## Files

- A file is a file and a directory a directory. Names are 1 to 10 characters, without `.` `:` `"` `*` `#` `|`, a space
  or anything outside printable ASCII, and match whatever the case. A `.` in a host name is a `/` to the BBC, so
  `prog.bas` is `prog/bas`.
- A file whose name cannot be given to the BBC is not shown to it: a name that is too long, or has a space, a `:` `"`
  `*` `#` or `|`, or is not plain ASCII. `*CAT` says how many, and names the first few. The BBC cannot make a file
  called `$`, `&`, `@`, `%` or `^`, or one whose name ends in `/inf`, which as a host file would be a `.inf` sidecar.
- A file's load and exec addresses and its lock are in a `.inf` file beside it, `NAME.inf`, with a line like
  `$.NAME  FFFF1900 FFFF8023 00000A00 L`. These are the files BeebAsm, Baron (`--inf`) and b-em write and read, so
  Baron's `-p dir --inf` output is a folder VDFS serves. The name in the line is not used, the host's file name is. A
  file with no `.inf` has load and exec 0, and an unlocked file with both 0 gets no `.inf` when it is saved. Such a
  file can be loaded where you say (`*LOAD NAME 3000`), but not run, or loaded at its own address, since that is
  address 0.
- The folder is looked at when a call needs it, so a file added to it, or changed, is there for the next call. A file
  that is open has been read when it was opened, and is not read again.
- A symbolic link is not followed, in either direction. Every host path is checked to be inside the folder before it
  is used, since what runs on the BBC is not to be trusted with the rest of the disc.
- A file opened for output is made as it is opened, empty, as a disc's catalogue would have it, and is filled as it is
  closed, by a close of handle 0, `OSARGS` with A=&FF, or a break. Closing every file stops at one that cannot be
  written, and leaves it and the rest open to be written again. In Node, a machine that is stopped with a file open does
  not write it until `flushVdfs()`. The desktop app writes what is open as a window closes or the app quits, and a
  browser tries when the page is hidden or goes, which it cannot be made to finish. A file that has been deleted or
  replaced while it is open is no longer written.
- A transfer is of memory the 6502 has: no more than 64K at a time, not over the devices (`&FC00` to `&FEFF`), and not
  past the top. A file is at most 16 MB.
- A store that cannot do what is asked, such as a full disc or a folder it may not write, gives the BBC an error,
  "Disc fault" and the reason. A file that cannot be written once the BBC has gone, as at a break or when the page goes,
  is reported to the page, which says so.

## What it does

Filing system calls: `OSFILE` 0 to 6, 8 and &FF; `OSFIND`, `OSBGET`, `OSBPUT`, `OSARGS` (the file's pointer and
extent, and the filing system's number), `OSGBPB` 1 to 4, and `FSC` for EOF, `*RUN`, `*CAT`, `*EX`, `*INFO` and
unrecognised commands, which are run as a program if they name a file in the current directory or the library.

Commands: `*VDFS`, `*CAT`, `*DIR`, `*LIB`, `*CDIR`, `*DELETE`, `*ACCESS` (`L` or nothing), `*SETINFO name load [exec]`
(hexadecimal; a file with no `.inf` has load and exec 0 and cannot be run until one of them is set), `*INFO` and `*EX`
(with `*` and `#` wildcards), and `*HELP VDFS`. Directories are as ADFS has them: `$` is the root, `@` the current directory, `%`
the library, `^` the parent, and a `:0.` drive is ignored.

VDFS needs a MOS that takes service ROMs, so it is for the BBC models other than the Atom and MOS 0.10, which takes the
first ROM in its sockets for its language and does not boot with one that is not. It has been run on MOS 1.20, the US
and German MOS and the Master's MOS 3.20 (with the DFS, ADFS and ANFS). The filing system vectors are claimed through
the OS's extended vector entry points, `&FF1B` to `&FF2D`, which every filing system ROM jsbeeb has (DFS, ADFS, ANFS,
DNFS) and the Master's and the Compact's MOS contain.

Not done: `OSGBPB` 5 to 8, `OSFILE` 7, `OSARGS` with A=1 and Y=0 (the rest of the command line), `*RENAME`, `*COPY`,
`*TITLE`, `*OPT` (it is accepted and ignored), `*ACCESS` of a wildcard (it takes one name), sector
access (`OSWORD` &7F, or a game that drives the disc controller itself), and the second processor: an address that is
not in the I/O processor (`&FFFFxxxx`) is an error when one is fitted. A snapshot does not hold open
files, and restoring one closes them. `BGET` at the end of a file gives `&FE` with the carry set each time, where a DFS raises
"EOF" the second time, and a file can be opened twice: the DFS says "Open", this does not, and the last close wins.

## The ROM and the host

The ROM's code is about 400 bytes, in a 16K image like any other ROM's. It holds no state and no text, and does no
parsing; the host parses `*` commands, makes the `*CAT` listing and decides what is an error. The ROM hands over a call,
waits for it, and does what it is told.

### The ports

Eight bytes in FRED, at `&FC60` to `&FC67`. These are not an Acorn allocation, they are jsbeeb's.

| Offset | Name   | Write                                    | Read                                                     |
| ------ | ------ | ---------------------------------------- | -------------------------------------------------------- |
| 0      | CALL   | The call's number, which starts the call | Bit 7 set while the host is still doing the call, else 0 |
| 1      | A      | A as the caller had it                   |                                                          |
| 2      | X      | X as the caller had it                   |                                                          |
| 3      | Y      | Y as the caller had it                   |                                                          |
| 4      | P      | The flags as the caller had them         |                                                          |
| 5      | STREAM | Chooses the stream DATA reads            | The stream that has the last call's response             |
| 6      | DATA   |                                          | The next byte of the chosen stream                       |
| 7      | ID     |                                          | `&56`                                                    |

The ROM reads ID before it forwards a service call, and hands the call back to the OS untouched if there is no host.
That is very defensive: jsbeeb fits the ROM only with a host, but `rom=vdfs.rom` or a snapshot can put it in a machine
that has none, and it would crash there.

### Calls

Calls 1 to 7 are the filing system's vectors, with the registers and flags the OS gave them; call 0 is the ROM's
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

A call may take as long as the store does. After writing CALL the ROM reads it until bit 7 is clear, with
`BIT PortCall : BMI wait`, and the 6502 goes on running, interrupts and all, as it would waiting on a disc. A call
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

When the call is no longer busy there is a stream: a list of ops for the ROM to do, ending in `Done` and the registers to
return. The ROM reads STREAM for its number, then reads DATA for each byte, writing the number back to STREAM before each
read that could follow a call it made (the OS can call the filing system again while the ROM prints, with `*SPOOL`).
Streams are one per call, so a nested call does not disturb the one being read.

| Op  | Name  | Bytes after it                             | The ROM                                                             |
| --- | ----- | ------------------------------------------ | ------------------------------------------------------------------- |
| 0   | Done  | X, Y, P, A                                 | returns them, and the flags, to the caller                          |
| 1   | Print | text, 0                                    | writes it with `OSASCI`                                             |
| 2   | Error | error number, text, 0                      | raises it, as a `BRK` built in page 1; it does not return           |
| 3   | Exec  | high byte, low byte, of the address less 1 | pages in the language ROM and jumps to the address; does not return |
| 4   | Claim | none                                       | takes over the filing system vectors, and carries on                |

A stream with a `Done` returns normally. The host answers every failure of its own as an error, so a bug in the host
is a message on the BBC and not an exception in the emulator.

Claiming the vectors is the filing system's selection as the DFS does it: tell the one in use with `FSCV` call 6,
write the seven vectors to the OS's extended vector entries, put the extended vector table's entries in place
(found with `OSBYTE &A8`), and issue service call &F.

### The store

The host is given an object with these calls, each returning a promise, and the text of what it throws is what the
BBC's "Disc fault" says. A store may have more than this for its page: `FsStore.check()`, and the browser's
`permission()` and `requestPermission()`, which a folder the browser has to be asked about needs.
`src/vdfs-fs-store.js` is the one for a folder in Node, `src/web/vdfs-folder-store.js` the one for a folder in a
browser, and the desktop app's is the same as the Node one, over IPC to its main process. The names it is given and
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

## Not yet done

- `jsbeeb-mcp` could give an assistant a working folder with `vdfsFolder`.
