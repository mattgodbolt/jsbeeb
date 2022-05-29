## Wolfgang Lorenz's 6502 test suite

When Wolfgang Lorenz's excellent 6502 (well, actually there's some 6526
stuff in there as well) test suite was mentioned earlier on, I recalled
having re-packaged it a few years ago in a form more suitable for play
on non-Commodore platforms (it was originally provided as a D64 image).

In case anyone would find it useful I packed it up and put it online at
http://jegt.net/~palm/testsuite-2.15.tar.gz

Since it makes a few assumtions about the surrounding environment, I'd
also like to share a few notes on the "test bench" environment I hacked
up to be able to run it outside a C64:

The testcase is started by loading " start" and starting the CPU.

The load routine does the following:

Check the filename for "trap17" and exit if it is, since this is where testing of non-6510 stuff begins.

Read the starting address from the two first bytes of the file (LO, HI). Load the rest of the file into memory at the specified starting address.

Initialize some memory locations:

    $0002 = $00
    $A002 = $00
    $A003 = $80
    $FFFE = $48
    $FFFF = $FF
    $01FE = $FF
    $01FF = $7F

Set up the KERNAL "IRQ handler" at $FF48:

    FF48  48        PHA
    FF49  8A        TXA
    FF4A  48        PHA
    FF4B  98        TYA
    FF4C  48        PHA
    FF4D  BA        TSX
    FF4E  BD 04 01  LDA    $0104,X
    FF51  29 10     AND    #$10
    FF53  F0 03     BEQ    $FF58
    FF55  6C 16 03  JMP    ($0316)
    FF58  6C 14 03  JMP    ($0314)

Set `S` to `$FD`, `P` to `$04` and `PC` to `$0801`

Put trap instructions at `$FFD2`, `$E16F`, `$FFE4`, `$8000` and `$A474`, where the trap handler does the following:

if `PC == $FFD2` (Print character):

- Set `$030C = 0`
- Print `PETSCII` character corresponding to value of `A`
- Pop return address from stack
- Set `PC` to return address
- Re-start the CPU

if `PC == $E16F` (Load):

- `$BB` is `PETSCII` filename address, low byte
- `$BC` is `PETSCII` filename address, high byte
- `$B7` is `PETSCII` filename length
- Load the file
- Pop return address from stack
- Set `PC` to `$0816`
- Re-start the CPU

if `PC == $FFE4` (Scan keyboard):

- Set `A` to 3
- Pop return address from stack
- Set `PC` to return address
- Re-start the CPU

if `PC == $8000` or `PC == $A474`:

- Exit
