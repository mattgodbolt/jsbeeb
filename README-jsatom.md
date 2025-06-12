[![jsbeeb tests](https://github.com/mattgodbolt/jsbeeb/actions/workflows/test-and-deploy.yml/badge.svg)](https://github.com/mattgodbolt/jsbeeb/actions/workflows/test-and-deploy.yml)

# jsatom - JavaScript Acorn Atom Emulator (hidden within jsbeeb)

[![jsatom](public/images/jsatom-snapper.png)](https://jsatom.commandercoder.com/)

An Acorn Atom emulator written in JavaScript and running in modern browsers. Emulates a standard Atom with 12K RAM,
along with various expansion options and peripherals.

## Table of Contents

- [Keyboard Mappings](#keyboard-mappings)
- [Getting Set Up to Run Locally](#getting-set-up-to-run-locally)
- [URL Parameters](#url-parameters)
- [Patches](#patches)
- [Loading BASIC Files from GitHub Gists](#loading-basic-files-from-github-gists)
- [Things Left to Do](#things-left-to-do)
- [Tests](#tests)
- [Thanks](#thanks)
- [More Information](#more-information)
- [License](#license)
- [Contact](#contact)

## Keyboard Mappings

The Atom had a somewhat different keyboard layout to a modern PC, and so it's useful to know some of the mappings:

- Atom `BREAK` key is `F12`
- Atom `COPY` key is `TAB`, `F11`
- Atom `SHIFT LOCK` is `F1`
- Atom `REPT` key is mapped to `RIGHT SHIFT`
- Atom `CTRL` key is mapped to `LEFT SHIFT`
- Atom `SHIFT` key is mapped to `CTRL`

To play right now, visit [https://jsatom.commandercoder.com/](https://jsatom.commandercoder.com/). The Atom will boot directly to the BASIC prompt, ready for programming.

<img src="https://retrorepairsandrefurbs.com/wp-content/uploads/2021/09/img_6435-1.jpg?w=3136" width="400px" >

### Joystick Support

Unsupported.

## Getting Set Up to Run Locally

### Prerequisites

- Node.js (https://nodejs.org/)
- npm (comes with Node.js)

### Installation

1. Clone the repository:
   ```sh
   git clone https://github.com/mattgodbolt/jsbeeb.git
   cd jsbeeb
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Start the local webserver:
   ```sh
   npm start
   ```
4. Visit `http://localhost:5173/?model=atom` in your browser.

jsatom uses Node.js and vite to afford simple and standard web development tooling and third-party library access
without lots of painful copy/paste or wheel-reinventing, as well as the ability to better run tests, and "pack" up the
site to make it smaller and faster to load when it's deployed to [https://jsatom.commandercoder.com/](https://jsatom.commandercoder.com/).

## URL Parameters

**_These are mostly untested on the Acorn Atom implementation._**

- `autoboot` - automatically starts the system [MMC or Disc]
- `disc=XXX` - loads disc XXX (from the `discs/atom/` directory) into the drive, forces `model=ATOM-DOS`

- `mmc=XXX` - inserts SDCard as a zip file (from the `mmc\` directory), forces `model=ATOM`
- [future] `mmc=local:YYY` - creates a local SDCard which will be kept in browser local storage (empty cards can be created from the menu)
- `tape=XXX` - loads tape XXX (from the `tapes/atom/` directory), forces `model=ATOM-TAPE`
- `tape=local:YYY` - creates a local tape YYY which will be kept in browser local storage
- `patch=P` - applies a memory patch `P`. See below.
- `loadBasic=X` - loads 'X' (a resource on the webserver) as text, tokenises it and puts it in memory as if you'd typed
  it in to the emulator
- `embedBasic=X` - loads 'X' (a URI-encoded string) as text, tokenises it and puts it in memory as if you'd typed it in
  to the emulator
- `autorun` - types `RUN` after loading BASIC code.
- `autochain` - types `CHAIN""` to run from tape.
- `autotype` - types whatever you put after. e.g. `&autotype=PRINT"Hello User"%0a` (return is URI escaped to `%0a`)
- `embed` - Remove the margins around the screen, hide most navigation entries and make the page background
  transparent (intended for use when running within an iframe in a third-party site).
- `cpuMultiplier=X` speeds up the CPU by a factor of `X`. May be fractional or below one to slow the CPU down. NB disc
  loads become unreliable with a too-slow CPU, and running too fast might cause the browser to hang.
- `sbLeft` / `sbRight` / `sbBottom` - a URL to place left of, right of, or below the Atom monitor. The left and right
  should be around 480 high and the bottom image should be around 512 wide. Left and right wider than 300 will run into
  problems on smaller screens; bottom taller than 100 or so similarly.
- [untested] `videoCyclesBatch` - the number of video cycles to batch up before running the video emulation. Defaults to zero:
  anything higher leads to emulation inaccuracies. Useful for showing why accuracy is important, even if less efficient.
- [untested] `rom` - load the given URL or path as an extra ROM.
- [untested] `audioDebug=true` turns on some audio debug graphs.

## Patches

Patches can be applied by making a `patch=P` URL parameter. `P` is a sequence of semicolon-separated patches of the form
`@XXXX,YYYY:ZZZZZ,...` where the `@XXXX` specifies a PC address to breakpoint, the `YYYY` is the address to patch and
the `ZZZZ` is the data to write at address `YYYY`. The `@` part is optional, but is handy to ensure the code you want to
patch has actually loaded. For example: `patch=@f000,0200:a9ff8d0002` which patches the Atom's memory at startup.
Once the PC has reached `$f000`, the bytes at `0200` are replaced with `a9ff8d0002`.

## Loading BASIC Files from GitHub Gists

1. Create a gist with your code. https://gist.github.com/ - here's
   an [example](https://gist.github.com/mattgodbolt/fc8d6f3d6e5e015dce399013719c8341)
2. Get the "Raw" link by clicking "raw" and copying the URL. In the case above
   that's: https://gist.githubusercontent.com/mattgodbolt/fc8d6f3d6e5e015dce399013719c8341/raw/bd5cb4314bfc3ee4330783ecf82cb329a36b915c/foo.bas
3. Add that after "https://atom.xania.org/?autorun&loadBasic=" or similar, for
   example, [this link](https://atom.xania.org/?loadBasic=https://gist.githubusercontent.com/mattgodbolt/fc8d6f3d6e5e015dce399013719c8341/raw/bd5cb4314bfc3ee4330783ecf82cb329a36b915c/foo.bas&autorun)

Note that every update you make means you need to make a new raw link.

## Things Left to Do

If you're looking to help:

- Testing
  - Play lots of games and report issues either on [GitHub](https://github.com/CommanderCoder/jsbeeb/issues) or by email (
    andrew@commandercoder.com).
- Joystick support
- SID support
  - couple of SID players in javascript already so probably link to one of these
    - https://github.com/jhohertz/jsSID
    - https://github.com/og2t/jsSID
  - Save state ability
    - Once we have this I'd love to get some "reverse step" debugging support
- Memory expansion support
  - 32K RAM expansion emulation
- `git grep -i todo`

## Tests

See [jsbeeb tests](README.md#tests)

## Thanks

The Acorn Atom emulator was inspired by and makes heavy use of the 6502 emulator in jsbeeb. It benefits from the wealth of knowledge in the retro computing community.

Many thanks to David Banks for open sourcing the [Atomulator](http://acornatom.co.uk/) emulator. Also thanks to the Acorn Atom source on [Mame](https://github.com/mamedev/mame) and [Phil's Place](http://phils-place.co.uk/HTeMuLator/atom/) for unwittingly helping me with jsatom. The MMC loaded by default is the amazing [Acorn Atom Software Archive](https://github.com/hoglet67/AtomSoftwareArchive) created by David Banks.

Special shout out to the members of the [Stardot Forums](https://stardot.org.uk/forums/).

## More Information

I gave a very rough presentation in 2020 at
[ABug](https://www.youtube.com/watch?v=ga0F0FWfyeo). I'm happy to write up anything that you want to know about it on the [commandercoder](https://www.commandercoder.com/) website.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contact

For support or questions, please contact Andrew Hague at andrew@commandercoder.com.
