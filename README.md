[![Build Status](https://travis-ci.org/mattgodbolt/jsbeeb.svg?branch=master)](https://travis-ci.org/mattgodbolt/jsbeeb)

jsbeeb - Javascript BBC Micro emulator
--------------------------------------

A 32K BBC Model B micro computer emulator in Javascript.  Runs on Firefox and Chrome.
Key mappings you may find useful:

* BBC F0 is F10
* BBC Break key is F12
* BBC star is on " (if it doesn't work for you try shift-2)

To play right now, visit [http://bbc.godbolt.org/](http://bbc.godbolt.org/)

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
* `disc1=!YYY` - creates a local disk YYY which will be kept in browser local storage
* `disc1=|ZZZ` - loads disc ZZZ from the Stairway to Hell archive
* `tape=XXX` - loads tape XXX (from the `tapes/` directory)
* `tape=|ZZZ` - loads tape ZZZ from the Stairway to Hell archive
* `patch=P` - applies a memory patch `P`. See below.
* `loadBasic=X` - loads 'X' (a resource on the webserver) as text, tokenises it and puts it in `PAGE` as if you'd typed it in to the emulator

Patches
-------
Patches can be applied by making a `patch=P` URL parameter.  `P` is a sequence of semicolon separated patches of the form `@XXXX,YYYY:ZZZZZ,...` where the `@XXXX` specifies a PC address to breakpoint, the `YYYY` is the address to patch and the `ZZZZ` is the data to write at address `YYYY`. The `@` part is optional, but is handy to ensure the code you want to patch has actually loaded. For example: `patch=@31a6,0769:6e4c4d48465a` which is a patch for the default Elite image. Once the PC has reached `$31a6`, the bytes at `0769` are replaced with `6e4c4d48465a`.

TODO
----

If you're looking to help:

* Testing
  * Play lots of games and report issues either on [github](https://github.com/mattgodbolt/jsbeeb/issues) or by email (matt@godbolt.org).
* Core
  * Save state ability
  * Get the "boo" of the boot "boo-beep" working
* Master support
  * Mostly done, but still TODOs in the code
  * Needs a UI to select it.
  * Exile doesn't run, for some reason.
* Save disc support
  * I've started dropbox support, but it's not quite there yet.
  * Google Drive support would be nice
  * Local discs need to be made more workable and need an "export" feature
* `git grep -i todo`

Tests
-----

For general correctness there are several tests in the `tests` directory, including:

* Klaus Dorfmann's exhaustive test of all documented opcodes for 6502 and 65C12. 
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

Tests can be run automatically if you have `node` installed - just run `make` and it'll ensure the relevant libraries are installed, then it'll run the tests.
Please note it can take a while to run the whole test suite.

Thanks
------

Based on Tom Walker's C [B-Em emulator](http://b-em.bbcmicro.com/) -- thanks to him for his hard work and for open sourcing his code. 

Also huge thanks to Richard Talbot-Watkins for his advice and help along the way in fathoming out the instruction timings, interrupt fun
and for being such a good pal all these many years!

Thanks to Michael Borcherds for his help; improving the keyboard layouts and handling in Javascript, reporting issues, chasing down
game bugs and much more.

Thanks to [David Banks](https://github.com/hoglet67) for his help in testing the gnarly BCD flag behaviour on real live BBCs.

Cheers to [Ed Spittles](https://github.com/BigEd) for testing various interrupt timing code on a real BBC.

A lot of the early development used the amazing [Visual 6502](http://visual6502.org/) as reference for intra-instruction timings. Amazing stuff.

Special shout out the users of the [6502 Forums](http://forum.6502.org/)

More information
----------------

I've written a lot of how the innards work on [my blog](http://xania.org) in the [emulation](http://xania.org/Emulation-archive) section.
