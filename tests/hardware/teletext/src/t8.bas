REM T8 ULA switching at 2MHz
MODE 4
VDU 23,1,0;0;0;0;
VDU 19,1,1;0;
REM Screen start &2800: MA13 on, so the SAA5050 is fed the bytes the bitmap shows
FOR I%=&7C00 TO &7FFC STEP 4:!I%=-1:NEXT
FOR C%=0 TO 39
B%=&FF:IF C% AND 1 THEN B%=0
IF C% MOD 8=0 THEN B%=&F0
?(&7C00+C%)=B%:?(&7C28+C%)=B%:?(&7FC0+C%)=B%
IF C%<24 THEN ?(&7FE8+C%)=B%
NEXT
REM Straight to the CRTC: the Master MOS folds its *TV setting into R8 writes made through VDU 23
?&FE00=6:?&FE01=26
?&FE00=8:?&FE01=0
?&FE00=12:?&FE01=&28
?&FE00=13:?&FE01=0
DIM C% 255
FOR P=0 TO 2 STEP 2
P%=C%
[OPT P
SEI
LDA #2
STA &FE4D
.vs
BIT &FE4D
BEQ vs
LDA #1
STA &FE4D
\ 312 lines of 128 cycles per pass, so this stays locked to the raster
.frame
LDA &FE4D
AND #1
BNE exit
LDX #20
.d1
DEX
BNE d1
NOP
NOP
NOP
NOP
LDY #72
.pre
LDX #24
.d2
DEX
BNE d2
NOP
DEY
BNE pre
LDY #128
.band
LDA #&8A
LDX #6
.sw
STA &FE20
EOR #2
DEX
BNE sw
LDX #9
.d3
DEX
BNE d3
NOP
NOP
NOP
NOP
DEY
BNE band
LDY #111
.post
LDX #24
.d4
DEX
BNE d4
NOP
DEY
BNE post
NOP
NOP
JMP frame
.exit
LDA #&88
STA &FE20
CLI
RTS
]
NEXT
CALL C%
*FX15,1
CHAIN "MENU"
