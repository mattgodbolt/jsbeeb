jsbeeb - Javascript BBC Micro emulator
--------------------------------------

A 32K BBC Model B micro computer emulator in Javascript.  Runs on Firefox and Chrome.
Key mappings you may find useful:

* BBC F0 is F10
* BBC Break key is F12
* On a US keyboard, BBC star is on ".  For UK keyboards this is on 2 (sorry!)

To play right now, visit [http://bbc.godbolt.org/](http://bbc.godbolt.org/)

Getting set up
--------------

Fire up a local webserver and load it up.  I use `python` for this as it has a built-in webserver. So:

    $ cd jsbeeb
    $ python -mSimpleHTTPServer
    Serving HTTP on 0.0.0.0 port 8000 ...

Then visit http://localhost:8000/ and off you go.

URL parameters
--------------

* autoboot - fakes a shift break
* disc1=XXX - loads disc XXX (from the `discs/` directory) into drive 1
* disc2=XXX - as above
* disc1=!YYY - creates a local disk YYY which will be kept in browser local storage


TODO
----

If you're looking to help:

* Core
  * Save state ability
  * Get the "boo" of the boot "boo-beep" working
* Save disc support
  * I've started dropbox support, but it's not quite there yet.
  * Google Drive support would be nice
  * Local discs need to be made more workable and need an "export" feature
* `git grep -i todo`

Timings
-------

In the `tests` directory is a timing test program written by Rich.  It has been run on a real live BBC B and the results are in the directory.  An SSD of the same tests is in the `discs/` directory. The emulation now agrees 100% with this and there are tests to keep it in line.

Tests
-----

There are some simple tests of correctness against a few timing sources. Visit the `/tests` URL to run them.

Tests can be run automatically if you have `node` installed - just run `make` and it'll ensure the relevant libraries are installed, then it'll run the tests.

Thanks
------

Based on Tom Walker's C [B-Em emulator](http://b-em.bbcmicro.com/) -- thanks to him for his hard work and for open sourcing his code. Also huge thanks to Richard Talbot-Watkins for his advice and help along the way.

More information
----------------

I've written a lot of how the innards work on [my blog](http://xania.org) in the [emulation](http://xania.org/Emulation-archive) section.
