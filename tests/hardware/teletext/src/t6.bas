REM T6 flash timing
MODE 7
VDU 23,1,0;0;0;0;
PROCrule(1)
PROCrule(24)
GW$=CHR$151:FL$=CHR$136:BL$=CHR$255
PRINT TAB(0,0);CHR$134;"T6 FLASH TIMING";
PRINT TAB(0,2);CHR$131;"Flashing:";
FOR Y=3 TO 7
PRINT TAB(0,Y);GW$;FL$;
FOR I=2 TO 38
PRINT BL$;
NEXT
NEXT
PRINT TAB(0,9);CHR$131;"Steady:";
FOR Y=10 TO 14
PRINT TAB(0,Y);GW$;
FOR I=1 TO 38
PRINT BL$;
NEXT
NEXT
PRINT TAB(0,16);CHR$131;"Film the screen at a known high";
PRINT TAB(0,17);CHR$131;"frame rate and count the fields the";
PRINT TAB(0,18);CHR$131;"top band is missing for, against";
PRINT TAB(0,19);CHR$131;"the fields it is present for.";
PRINT TAB(0,21);CHR$131;"jsbeeb: 16 blanked of every 64.";
PRINT TAB(0,23);CHR$135;"Any key: menu";
*FX15,1
K=GET
CHAIN "MENU"
DEF PROCrule(Y)
LOCAL I
PRINT TAB(0,Y);CHR$151;
FOR I=1 TO 38
PRINT CHR$172;
NEXT
ENDPROC
