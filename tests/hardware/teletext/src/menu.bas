REM jsbeeb teletext hardware tests
MODE 7
VDU 23,1,0;0;0;0;
PRINT TAB(0,0);CHR$141;CHR$134;"jsbeeb teletext tests";
PRINT TAB(0,1);CHR$141;CHR$134;"jsbeeb teletext tests";
PRINT TAB(0,4);CHR$135;"1";CHR$134;" Hold graphics, held character";
PRINT TAB(0,6);CHR$135;"2";CHR$134;" Set-at / set-after under hold";
PRINT TAB(0,8);CHR$135;"3";CHR$134;" Double height";
PRINT TAB(0,10);CHR$135;"4";CHR$134;" Black codes, conceal, background";
PRINT TAB(0,12);CHR$135;"5";CHR$134;" Character set reference";
PRINT TAB(0,14);CHR$135;"6";CHR$134;" Flash timing";
PRINT TAB(0,16);CHR$135;"7";CHR$134;" Row edges";
PRINT TAB(0,18);CHR$135;"8";CHR$134;" ULA switching at 2MHz (MODE 4)";
PRINT TAB(0,20);CHR$131;"Photograph the whole screen for each.";
PRINT TAB(0,21);CHR$131;"Any key on a test page returns here.";
PRINT TAB(0,23);CHR$135;"Press 1 to 8";
*FX15,1
REPEAT
K=GET
UNTIL K>=49 AND K<=56
CHAIN "T"+CHR$K
