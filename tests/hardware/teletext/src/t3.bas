REM T3 double height
MODE 7
VDU 23,1,0;0;0;0;
PROCrule(1)
PROCrule(24)
DH$=CHR$141:NH$=CHR$140
GW$=CHR$151:HG$=CHR$158:BL$=CHR$255
PRINT TAB(0,0);CHR$134;"T3 DOUBLE HEIGHT";
PROCrow(3,"PAIR",DH$+"AaBbCc")
PROCrow(4,"LOW1",DH$+"AaBbCc")
PROCrow(6,"ONLY",DH$+"AaBbCc")
PROCrow(7,"LOW2","AaBbCc")
PROCrow(9,"MID","abc"+DH$+"DEF")
PROCrow(10,"MID2","abc"+DH$+"DEF")
PROCrow(12,"BACK",DH$+"AB"+NH$+"cd")
PROCrow(13,"BAK2",DH$+"AB"+NH$+"cd")
PROCrow(15,"TRI1",DH$+"Xx")
PROCrow(16,"TRI2",DH$+"Xx")
PROCrow(17,"TRI3",DH$+"Xx")
PROCrow(19,"HELD",GW$+BL$+HG$+DH$+HG$+HG$)
PRINT TAB(0,21);CHR$131;"On a lower row, is the normal-height";
PRINT TAB(0,22);CHR$131;"label at the left shown or blanked?";
PRINT TAB(0,23);CHR$135;"Any key: menu";
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
