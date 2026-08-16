REM T1 hold graphics and the held character
MODE 7
VDU 23,1,0;0;0;0;
GW$=CHR$151:GY$=CHR$147:AW$=CHR$135
HG$=CHR$158:RG$=CHR$159:SG$=CHR$154
NH$=CHR$140:MB$=CHR$172:BL$=CHR$255
F$=""
FOR I%=10 TO 39
F$=F$+HG$
NEXT
PRINT TAB(0,0);CHR$134;"T1 HOLD GRAPHICS / HELD CHAR";
PRINT TAB(7,2);CHR$131;"0123456789012345";
PROCrow(3,"REL",GW$+MB$+HG$+RG$+HG$+HG$)
PROCrow(4,"COL",GW$+MB$+HG$+GY$+HG$+HG$)
PROCrow(5,"SEP",GW$+BL$+HG$+SG$+HG$+HG$)
PROCrow(6,"CTL",GW$+MB$+GY$+HG$+HG$)
PROCrow(7,"ALF",GW$+MB$+HG$+AW$+GW$+HG$+HG$)
PROCrow(8,"CHR",GW$+MB$+"A"+HG$+HG$)
PROCrow(9,"SPC",GW$+MB$+" "+HG$+HG$)
PROCrow(10,"NHT",GW$+MB$+HG$+NH$+HG$+HG$)
PROCrow(11,"ROW",GW$+MB$+F$)
PRINT TAB(0,12);GW$;HG$;HG$;AW$;"cells 0,1: held from row above?";
PRINT TAB(0,14);CHR$131;"Cell 0 is screen column 8. The bar";
PRINT TAB(0,15);CHR$131;"continues while a block is held.";
PRINT TAB(0,17);CHR$131;"REL cells 4,5: bar or gap?";
PRINT TAB(0,19);CHR$135;"Any key: menu";
*FX15,1
K=GET
CHAIN "MENU"
END
DEF PROCrow(Y,L$,S$)
PRINT TAB(0,Y);L$;TAB(8,Y);S$;
ENDPROC
