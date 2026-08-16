REM T5 character set reference
MODE 7
VDU 23,1,0;0;0;0;
PROCrule(1)
PROCrule(24)
GW$=CHR$151:SG$=CHR$154:DH$=CHR$141
A$=FNchars(&20,&3F)
B$=FNchars(&40,&5F)
C$=FNchars(&60,&7F)
PRINT TAB(0,0);CHR$134;"T5 CHARACTER SET";
PROCrow(2,"A1",4,A$)
PROCrow(3,"A2",4,B$)
PROCrow(4,"A3",4,C$)
PROCrow(6,"C1",3,GW$+A$)
PROCrow(7,"C2",3,GW$+C$)
PROCrow(9,"S1",2,GW$+SG$+A$)
PROCrow(10,"S2",2,GW$+SG$+C$)
PROCrow(12,"G@",3,GW$+B$)
PROCrow(14,"DH",4,DH$+"AWjgy 0123 ()#")
PROCrow(15,"DH",4,DH$+"AWjgy 0123 ()#")
PRINT TAB(0,18);CHR$131;"A=alpha C=contiguous S=separated";
PRINT TAB(0,19);CHR$131;"G@ is &40-&5F seen in graphics mode.";
PRINT TAB(0,20);CHR$131;"DH shows the rounding on diagonals.";
PRINT TAB(0,22);CHR$135;"Any key: menu";
*FX15,1
K=GET
CHAIN "MENU"
END
DEF PROCrow(Y,L$,X,S$)
PRINT TAB(0,Y);L$;TAB(X,Y);S$;
ENDPROC
DEF FNchars(F,T)
LOCAL S$,C
S$=""
FOR C=F TO T
S$=S$+CHR$(C+128)
NEXT
=S$
DEF PROCrule(Y)
LOCAL I
PRINT TAB(0,Y);CHR$151;
FOR I=1 TO 38
PRINT CHR$172;
NEXT
ENDPROC
