REM T7 row edges
MODE 7
VDU 23,1,0;0;0;0;
PROCrule(1)
PROCrule(24)
GW$=CHR$151:AW$=CHR$135
HG$=CHR$158:MB$=CHR$172
H$=FNrepeat(HG$,30)
PRINT TAB(0,0);CHR$134;"T7 ROW EDGES";
PRINT TAB(29,2);CHR$131;"0123456789";
PROCrow(4,"EDGE",GW$+MB$+H$)
PRINT TAB(0,5);GW$;HG$;HG$;AW$;"cells 1,2 after a held row";
PROCrow(7,"SP3",GW$+MB$+FNrepeat(HG$,27)+"   ")
PROCrow(8,"SP1",GW$+MB$+FNrepeat(HG$,29)+" ")
PROCrow(10,"MOS",GW$+FNrepeat(MB$,31))
PRINT TAB(0,12);GW$;MB$;HG$;HG$;AW$;"cells 1,2,3 at the left edge";
PRINT TAB(0,14);CHR$131;"Ruler above marks columns 30 to 39.";
PRINT TAB(0,15);CHR$131;"EDGE: how far right does the bar go?";
PRINT TAB(0,16);CHR$131;"SP3, SP1: spaces clear the held char,";
PRINT TAB(0,17);CHR$131;"so where does the bar stop?";
PRINT TAB(0,18);CHR$131;"MOS: mosaics with no hold, to col 39.";
PRINT TAB(0,20);CHR$135;"Any key: menu";
*FX15,1
K=GET
CHAIN "MENU"
END
DEF PROCrow(Y,L$,S$)
PRINT TAB(0,Y);L$;TAB(8,Y);S$;
ENDPROC
DEF PROCrule(Y)
LOCAL I
PRINT TAB(0,Y);CHR$151;
FOR I=1 TO 38
PRINT CHR$172;
NEXT
ENDPROC
DEF FNrepeat(C$,N)
LOCAL S$,I
S$=""
FOR I=1 TO N
S$=S$+C$
NEXT
=S$
