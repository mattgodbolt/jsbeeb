[![Build Status](https://travis-ci.org/mattgodbolt/jsbeeb.svg?branch=master)](https://travis-ci.org/mattgodbolt/jsbeeb)
[![Codewake](https://www.codewake.com/badges/ask_question_flat_square.svg)](https://www.codewake.com/p/jsbeeb)

jsbeeb - Javascript BBC Micro emulator
--------------------------------------

A BBC Micro emulator in Javascript.  Runs on Firefox, Chrome and Microsoft Edge. Emulates a 32K BBC B (with sideways RAM)
and a 128K BBC Master. The BBC had a somewhat different-looking keyboard to a modern PC, and so it's useful to 
know some of the mappings:

* BBC F0 is F10
* BBC Break key is F12
* BBC star is on " (if it doesn't work for you try shift-2)

To play right now, visit [http://bbc.godbolt.org/](http://bbc.godbolt.org/). To load the default disc image (Elite in
this case), press shift-F12 (which is shift-Break on the BBC).

Getting set up to run locally
-----------------------------

Fire up a local webserver and load it up.  I use `python` for this as it has a built-in webserver. So:

    $ cd jsbeeb
    $ python -mSimpleHTTPServer
    Serving HTTP on 0.0.0.0 port 8000 ...

Then visit http://localhost:8000/ and off you go.

URL parameters
--------------

* `autoboot` - fakes a shift break
* `disc1=XXX` - loads disc XXX (from the `discs/` directory) into drive 1
* `disc2=XXX` - as above
* `disc1=local:YYY` - creates a local disk YYY which will be kept in browser local storage
* `disc1=sth:ZZZ` - loads disc ZZZ from the Stairway to Hell archive
* `tape=XXX` - loads tape XXX (from the `tapes/` directory)
* `tape=sth:ZZZ` - loads tape ZZZ from the Stairway to Hell archive
* `patch=P` - applies a memory patch `P`. See below.
* `loadBasic=X` - loads 'X' (a resource on the webserver) as text, tokenises it and puts it in `PAGE` as if you'd typed it in to the emulator
* `embedBasic=X` - loads 'X' (a URI-encoded string) as text, tokenises it and puts it in `PAGE` as if you'd typed it in to the emulator
* `autorun` - types `*TAPE` then `*/` to run from tape. In conjunction with `loadBasic` it types `RUN`.
* `autochain` - types `*TAPE` then `CH.""` to run from tape.a
* `embed` - Adjust the navigation entries to make the page clearer within a 921x733 iframe in a third-party site.
* `cpuMultiplier=X` speeds up the CPU by a factor of `X`. May be fractional or below one to slow the CPU down. NB disc loads become unreliable with a too-slow CPU, and running too fast might cause the browser to hang.
* `sbLeft` / `sbRight` / `sbBottom` - a URL to place left of, right of, or below the cub monitor. The left and right should be around 648 high and the bottom image should be around 896 wide. Left and right wider than 300 will run into problems on smaller screens; bottom taller than 100 or so similarly.
* `videoCyclesBatch` - the number of video cycles to batch up befofre running the video emulation. Defaults to zero: anything higher leads to emulation inaccuracies. Useful for showing why accuracy is important, even if less efficient.
* `rom` - load the given URL or path as an extra ROM. If a URL is provided, that URL must allow cross-site requests. Doesn't support the sth: pseudo URL unlike `disc` and `tape`, but if given a ZIP file will attempt to use the `.rom` file assumed to be within.

Patches
-------
Patches can be applied by making a `patch=P` URL parameter.  `P` is a sequence of semicolon separated patches of the form `@XXXX,YYYY:ZZZZZ,...` where the `@XXXX` specifies a PC address to breakpoint, the `YYYY` is the address to patch and the `ZZZZ` is the data to write at address `YYYY`. The `@` part is optional, but is handy to ensure the code you want to patch has actually loaded. For example: `patch=@31a6,0769:6e4c4d48465a` which is a patch for the default Elite image. Once the PC has reached `$31a6`, the bytes at `0769` are replaced with `6e4c4d48465a`.

Loading BASIC files from GitHub gists
----
* Create a gist with your code. https://gist.github.com/ - here's an [example](https://gist.github.com/mattgodbolt/fc8d6f3d6e5e015dce399013719c8341)
* Get the "Raw" link by clicking "raw" and copying the URL . In the case above that's: https://gist.githubusercontent.com/mattgodbolt/fc8d6f3d6e5e015dce399013719c8341/raw/bd5cb4314bfc3ee4330783ecf82cb329a36b915c/foo.bas
* Add that after "https://bbc.godbolt.org/?autorun&loadBasic=" or similar, for example, [this link](https://bbc.godbolt.org/?loadBasic=https://gist.githubusercontent.com/mattgodbolt/fc8d6f3d6e5e015dce399013719c8341/raw/bd5cb4314bfc3ee4330783ecf82cb329a36b915c/foo.bas&autorun)

Note that every update you make means you need to make a new raw link.

Things left to do
----

If you're looking to help:

* Testing
  * Play lots of games and report issues either on [github](https://github.com/mattgodbolt/jsbeeb/issues) or by email (matt@godbolt.org).
* Core
  * Save state ability
    * Once we have this I'd love to get some "reverse step" debugging support
  * Get the "boo" of the boot "boo-beep" working (disabled currently as the Javascript startup makes the sound dreadfully
    choppy on Chrome at least).
* Save disc support
  * Local discs need to be made more workable and need an "export" feature
  * Multiple discs need a UI
* `git grep -i todo`
* Optimisation
  * While every attempt to make things fast has been made, I'm sure there's some more clever things that can be done without
    compromising emulation accuracy
  
Tests
-----

For general correctness there are several tests in the `tests` directory, including:

* Klaus Dormann's exhaustive test of all documented opcodes for 6502 and 65C12. 
  This is brought in as a git submodule from a forked version of Klaus's original as it needed
  a few tweaks to get 65C12 working.
* hoglet's Binary Coded Decimal tests.
* A public domain Commodore 64 6502 test suite which tests every 6502 opcode (documented or
  otherwise) for every possible input and flags condition.

For timing correctness we have:

* A timing test program written by Rich.  It has been run on a real live BBC B and
  the results are in the directory.  An SSD of the same tests is in the `discs/` directory.
* Some of Kevin Edwards' protection systems (stripped of the games themselves). These are extremely
  timing- and correctness-sensitive when it comes to the timers and interrupts of the BBC.
* Some 65C12-specific read-modify-write tests written by Ed Spittles.

Tests can be run automatically if you have `node` installed - just run `make` and it'll ensure the relevant libraries are installed, then it'll run the tests.
Please note it can take a while to run the whole test suite.

Thanks
------

jsbeeb was heavily based on Sarah Walker's C [B-Em emulator](http://b-em.bbcmicro.com/) -- thanks to her for her hard work and for open sourcing her code. 

Huge thanks to Richard Talbot-Watkins for his advice and help along the way in fathoming out the instruction timings, interrupt fun,
video code rewrite and for being such a good pal all these many years!

Thanks to [Michael Borcherds](https://twitter.com/mike_geogebra) for his help; improving the keyboard layouts and handling in Javascript, reporting issues, chasing down
game bugs and much more.

Thanks to [David Banks](https://github.com/hoglet67) (hoglet) for his help in testing the gnarly BCD flag behaviour on real live BBCs.

Cheers to [Ed Spittles](https://github.com/BigEd) for testing various interrupt timing code on a real BBC.

Thanks to Chris Jordan for his thorough testing, bug reports, ideas and help.

A lot of the early development used the amazing [Visual 6502](http://visual6502.org/) as reference for intra-instruction timings. Amazing stuff.

Special shout out the users of the [6502 Forums](http://forum.6502.org/)

More information
----------------

I've written a lot of how the innards work on [my blog](http://xania.org) in the [emulation](http://xania.org/Emulation-archive) section.  
I gave a presentation on how it all fits together at work, and posted the [video up on YouTube](https://www.youtube.com/watch?v=37jyHQT7fXQ). 
I presented again at [GOTO Chicago 2016](http://gotocon.com/chicago-2016/presentation/Emulating%20a%206502%20system%20in%20Javascript), and I'm
hoping they post the video up.
