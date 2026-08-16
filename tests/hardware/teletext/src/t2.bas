REM T2 set-at or set-after, seen through hold graphics
MODE 7
VDU 23,1,0;0;0;0;
PROCrule(1)
PROCrule(24)
GW$=CHR$151:GY$=CHR$147
HG$=CHR$158:FL$=CHR$136:SY$=CHR$137
CN$=CHR$152:NB$=CHR$157:BB$=CHR$156:DH$=CHR$141
MB$=CHR$172
PRINT TAB(0,0);CHR$134;"T2 SET-AT / SET-AFTER UNDER HOLD";
PRINT TAB(7,2);CHR$131;"0123456789012345";
PROCrow(3,"STDY",GW$+FL$+MB$+MB$+HG$+SY$+MB$+MB$)
PROCrow(4,"FLSH",GW$+MB$+MB$+HG$+FL$+MB$+MB$)
PROCrow(5,"CNCL",GW$+MB$+MB$+HG$+CN$+MB$+MB$)
PROCrow(6,"HOLD",GW$+MB$+HG$+MB$+MB$)
PROCrow(7,"NEWB",GY$+MB$+MB$+HG$+NB$+GW$+MB$+MB$)
PROCrow(8,"BLKB",GY$+NB$+GW$+MB$+MB$+HG$+BB$+MB$+MB$)
PROCrow(10,"DBLH",GW$+MB$+MB$+HG$+DH$+MB$+MB$)
PRINT TAB(0,13);CHR$131;"Cell 0 is screen column 8.";
PRINT TAB(0,14);CHR$131;"STDY cell 5: flashing or steady?";
PRINT TAB(0,15);CHR$131;"FLSH cell 4: flashing or steady?";
PRINT TAB(0,16);CHR$131;"CNCL cell 4: bar or gap?";
PRINT TAB(0,17);CHR$131;"NEWB cell 4, BLKB cell 6: black or";
PRINT TAB(0,18);CHR$131;"yellow above and below the bar?";
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
