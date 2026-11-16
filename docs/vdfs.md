# VDFS

VDFS is a filing system whose files are the host's: a folder on this computer is the BBC's `$`, its files are the
BBC's files, and what the BBC saves is in the folder. It is the same idea as b-em's VDFS and MMFS on a Pi, with a
host that is jsbeeb.

It is a sideways ROM (`public/roms/vdfs.rom`, from `roms-src/vdfs`) and a device the ROM talks to (`src/vdfs-host.js`).
The ROM is the OS's side of it: it takes over the filing system vectors and forwards every call. The host does the
work.

## Using it

In Node, give `MachineSession` a folder:

```js
const session = new MachineSession("B-DFS1.2", { vdfsFolder: "/path/to/games" });
await session.initialise();
await session.boot();
await session.type("*VDFS");
```

`*VDFS` selects the filing system. Files the BBC writes reach the folder as they are closed, saved, or flushed;
`await session.flushVdfs()` is the way to know they have, for a test that then looks in the folder.

VDFS is not the filing system a break starts with, because the DFS sits in a higher ROM bank than a fitted ROM can
take and so sees the boot service call first. `*VDFS` does it, and `autotype` can type it.

## Files

- A file is a file and a directory a directory. Names are 1 to 10 characters, without `.` `:` `"` `*` `#` `|`, a space or
  anything outside printable ASCII, and match whatever the case; a host name that is not one is left out. A `.` in a
  host name is a `/` to the BBC, so `prog.bas` is `prog/bas`.
- A file's load and exec addresses and its lock are in a `.inf` file beside it, `NAME.inf`, with a line like
  `$.NAME  FFFF1900 FFFF8023 00000A00 L`. These are the files BeebAsm, Baron (`--inf`) and b-em write and read, so
  Baron's `-p dir --inf` output is a folder VDFS serves. The name in the line is not used, the host's file name is. A
  file with no `.inf` has load and exec 0, and an unlocked file with both 0 gets no `.inf` when it is saved. Such a
  file can be loaded where you say (`*LOAD NAME 3000`), but not run, or loaded at its own address, since that is
  address 0.
- A transfer is of memory the 6502 has: no more than 64K at a time, not over the devices (`&FC00` to `&FEFF`), and not
  past the top. A file is at most 16 MB.
- The folder is read once, when the machine is made. Changes made to it afterwards are not seen, and when the BBC next
  writes a file it replaces whatever the folder has of that name.
- A symbolic link is not followed, in either direction. Every host path is checked to be inside the folder before it
  is written, since what runs on the BBC is not to be trusted with the rest of the disc.
- Open files are written to the folder when they are closed, by a close of handle 0, `OSARGS` with A=&FF, or a
  break. A machine that is stopped with a file open does not write it. A file that has been deleted or replaced while
  it is open is no longer written.
- In the desktop app, serving or stopping a folder starts the page again, which discards the machine that was running.
  The page is asked to hand over what the BBC wrote first, and to stop writing, so what the BBC saves in the moment
  before the page is replaced is dropped; so is a window that is closed, or an app that is quit.
- The BBC is told its write succeeded before the folder has it. A write that then fails is logged, and the page says
  so in a toast (`volume.onPersistFailure`), but the BBC does not hear of it.

## What it does

Filing system calls: `OSFILE` 0 to 6, 8 and &FF; `OSFIND`, `OSBGET`, `OSBPUT`, `OSARGS` (the file's pointer and
extent, and the filing system's number), `OSGBPB` 1 to 4, and `FSC` for `*OPT`, EOF, `*RUN`, `*CAT`, `*EX`, `*INFO`
and unrecognised commands, which are run as a program if they name a file in the current directory or the library.

Commands: `*VDFS`, `*CAT`, `*DIR`, `*LIB`, `*CDIR`, `*DELETE`, `*ACCESS` (`L` or nothing), `*INFO` and `*EX` (with
`*` and `#` wildcards), and `*HELP VDFS`. Directories are as ADFS has them: `$` is the root, `@` the current
directory, `%` the library, `^` the parent, and a `:0.` drive is ignored.

Not done: `OSGBPB` 5 to 8, `OSFILE` 7, `*RENAME`, `*COPY`, `*TITLE`, sector access (`OSWORD` &7F, or a game that
drives the disc controller itself), and the second processor: an address that is not in the I/O processor (`&FFFFxxxx`)
is an error when one is fitted. A snapshot does not hold open files, and restoring one closes them.

## The ROM and the host

The ROM's code is about 400 bytes, in a 16K image like any other ROM's. It holds no state and no text, and does no parsing; the host parses `*` commands,
makes the `*CAT` listing and decides what is an error. The ROM hands over a call and does what it is told.

### The ports

Eight bytes in FRED, at `&FC60` to `&FC67`. These are not an Acorn allocation, they are jsbeeb's.

| Offset | Name   | Write                                                              | Read                                         |
| ------ | ------ | ------------------------------------------------------------------ | -------------------------------------------- |
| 0      | CALL   | The call's number. The host runs the call before the write is done | 0                                            |
| 1      | A      | A as the caller had it                                             |                                              |
| 2      | X      | X as the caller had it                                             |                                              |
| 3      | Y      | Y as the caller had it                                             |                                              |
| 4      | P      | The flags as the caller had them                                   |                                              |
| 5      | STREAM | Chooses the stream DATA reads                                      | The stream that has the last call's response |
| 6      | DATA   |                                                                    | The next byte of the chosen stream           |
| 7      | ID     |                                                                    | `&56`                                        |

The ROM reads ID before it forwards a service call, and hands the call back to the OS untouched if there is no host. That is very defensive: jsbeeb fits the ROM only with a host, but `rom=vdfs.rom` or a snapshot can put it in a machine that has none, and it would crash there.

### Calls

Calls 1 to 7 are the filing system's vectors, with the registers and flags the OS gave them; call 0 is the ROM's
service entry, with A the service number, X the ROM's slot and Y the parameter. The ROM forwards services 4 (command),
9 (help) and &12 (filing system selected). The numbers are in `roms-src/vdfs/contract.6502`, and
`tests/unit/test-vdfs-host.js` fails if `src/vdfs-host.js` has different ones.

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

### The response

Writing CALL makes a stream: a list of ops for the ROM to do, ending in `Done` and the registers to return. The ROM
reads STREAM for its number, then reads DATA for each byte, writing the number back to STREAM before each read that
could follow a call it made (the OS can call the filing system again while the ROM prints, with `*SPOOL`). Streams
are one per call, so a nested call does not disturb the one being read.

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

- A host for Electron, and for Chromium's File System Access API. The host's store is an object with `load()` and
  `writeFile`, `makeDirectory` and `remove`, each of which can be asynchronous; `src/vdfs-fs-store.js` is the one for a
  folder in Node.
- The files are all in memory, so a folder of many hundreds of games is as large in memory as it is on the disc.
- `jsbeeb-mcp` could give an assistant a working folder with `vdfsFolder`.
