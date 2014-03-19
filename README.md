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

If you're looking to help

* HTML/web
  * More discs and/or somehow XSS-request discs from other archives
* Core
  * Save ability
  * Get the "boo" of the boot "boo-beep" working
* `git grep -i todo`
* Timings (see below)

Timings
-------

In the `tests` directory is a timing test program written by Rich.  It has been run on a real live BBC B and the results are in the directory.  An SSD of the same tests is in the `discs/` directory. We're working on making jsbeeb agree with the real Beeb.

Thanks
------

Based on Tom Walker's C [B-Em emulator](http://b-em.bbcmicro.com/). Huge thanks to him for his hard work and for open sourcing his code. Also huge thanks to Richard Talbot-Watkins for his advice and help along the way.
