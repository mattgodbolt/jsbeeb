"use strict";
import * as utils from "./utils.js";
import * as jsunzip from "./lib/jsunzip.js";

/*
highly adapted from:
https://github.com/hoglet67/Atomulator
in the src/atommc folder

Simulate the AtoMMC2 device, which is a MMC/SD card reader for the Acorn Atom.

First create a dictionary of the MMC data from a zipped file, into uFiles and names.  This will end up in
this.MMCdata.

The Acorn Atom MMC2 eprom will communicate with the MMC via 0xb400-0xb40c, which is the Atom side of the MMC2 device.
The write() is called when 0xb400-0xb40c is written, read() is called when 0xb400-0xb40c is read.

the low byte determines which register is being accessed.
The registers are:
CMD_REG: 0xb400
LATCH_REG: 0xb401
READ_DATA_REG: 0xb402
WRITE_DATA_REG: 0xb403
STATUS_REG: 0xb404

*/

// Access an MMC file (zipped)
const CMD_REG = 0x0;
const LATCH_REG = 0x1;
const READ_DATA_REG = 0x2;
const WRITE_DATA_REG = 0x3;
const STATUS_REG = 0x4;

const CMD_DIR_OPEN = 0x0;
const CMD_DIR_READ = 0x1;
const CMD_DIR_CWD = 0x2;

const CMD_FILE_CLOSE = 0x10;
const CMD_FILE_OPEN_READ = 0x11;
// const CMD_FILE_OPEN_IMG = 0x12;
const CMD_FILE_OPEN_WRITE = 0x13;
const CMD_FILE_DELETE = 0x14;
const CMD_FILE_GETINFO = 0x15;
const CMD_FILE_SEEK = 0x16;
const CMD_FILE_OPEN_RAF = 0x17;

const CMD_INIT_READ = 0x20;
const CMD_INIT_WRITE = 0x21;
const CMD_READ_BYTES = 0x22;
const CMD_WRITE_BYTES = 0x23;

// EXEC_PACKET_REG "commands"
const CMD_EXEC_PACKET = 0x3f;

// UTIL_CMD_REG commands
const CMD_GET_CARD_TYPE = 0x80;
const CMD_GET_PORT_DDR = 0xa0;
const CMD_SET_PORT_DDR = 0xa1;
const CMD_READ_PORT = 0xa2;
const CMD_WRITE_PORT = 0xa3;
const CMD_GET_FW_VER = 0xe0;
const CMD_GET_BL_VER = 0xe1;
const CMD_GET_CFG_BYTE = 0xf0;
const CMD_SET_CFG_BYTE = 0xf1;
const CMD_READ_AUX = 0xfd;
const CMD_GET_HEARTBEAT = 0xfe;

// Status codes
const STATUS_OK = 0x3f;
const STATUS_COMPLETE = 0x40;
const STATUS_EOF = 0x60;
const STATUS_BUSY = 0x80;

// STATUS_REG bit masks
const MMC_MCU_BUSY = 0x01;
const MMC_MCU_READ = 0x02;
const MMC_MCU_WROTE = 0x04;

const VSN_MAJ = 2;
const VSN_MIN = 10;
const FA_OPEN_EXISTING = 0;
const FA_READ = 1;

// See https://github.com/hoglet67/AtoMMC2Firmware
/*
          atmmmc2def.h Symbolic defines for AtoMMC2

        2011-05-25, Phill Harvey-Smith.


    // Register definitions, these are offsets from 0xB400 on the Atom side.

        #define CMD_REG			0x00
        #define LATCH_REG		0x01
        #define READ_DATA_REG		0x02
        #define WRITE_DATA_REG		0x03
        #define STATUS_REG		0x04

    // DIR_CMD_REG commands
        #define CMD_DIR_OPEN		0x00
        #define CMD_DIR_READ		0x01
        #define CMD_DIR_CWD		0x02

    // CMD_REG_COMMANDS
        #define CMD_FILE_CLOSE		0x10
        #define CMD_FILE_OPEN_READ	0x11
        #define CMD_FILE_OPEN_IMG	0x12
        #define CMD_FILE_OPEN_WRITE	0x13
        #define CMD_FILE_DELETE		0x14
        #define CMD_FILE_GETINFO	0x15
        #define CMD_FILE_SEEK		0x16
        #define CMD_FILE_OPEN_RAF       0x17

        #define CMD_INIT_READ		0x20
        #define CMD_INIT_WRITE		0x21
        #define CMD_READ_BYTES		0x22
        #define CMD_WRITE_BYTES		0x23

    // READ_DATA_REG "commands"

    // EXEC_PACKET_REG "commands"
        #define CMD_EXEC_PACKET		0x3F

    // SDOS_LBA_REG commands
        #define CMD_LOAD_PARAM		0x40
        #define CMD_GET_IMG_STATUS	0x41
        #define CMD_GET_IMG_NAME	0x42
        #define CMD_READ_IMG_SEC	0x43
        #define CMD_WRITE_IMG_SEC	0x44
        #define CMD_SER_IMG_INFO	0x45
        #define CMD_VALID_IMG_NAMES	0x46
        #define CMD_IMG_UNMOUNT		0x47

    // UTIL_CMD_REG commands
        #define CMD_GET_CARD_TYPE	0x80
        #define CMD_GET_PORT_DDR	0xA0
        #define CMD_SET_PORT_DDR	0xA1
        #define CMD_READ_PORT		0xA2
        #define CMD_WRITE_PORT		0xA3
        #define CMD_GET_FW_VER		0xE0
        #define CMD_GET_BL_VER		0xE1
        #define CMD_GET_CFG_BYTE	0xF0
        #define CMD_SET_CFG_BYTE	0xF1
        #define CMD_READ_AUX		0xFD
        #define CMD_GET_HEARTBEAT	0xFE


    // Status codes
        #define STATUS_OK		0x3F
        #define STATUS_COMPLETE		0x40
        #define STATUS_EOF		0x60
        #define	STATUS_BUSY		0x80

        #define ERROR_MASK		0x3F

    // To be or'd with STATUS_COMPLETE
        #define ERROR_NO_DATA		0x08
        #define ERROR_INVALID_DRIVE	0x09
        #define ERROR_READ_ONLY		0x0A
        #define ERROR_ALREADY_MOUNT	0x0A
        #define ERROR_TOO_MANY_OPEN	0x12

    // Offset returned file numbers by 0x20, to disambiguate from errors
        #define FILENUM_OFFSET		0x20

    // STATUS_REG bit masks
    //
    // MMC_MCU_BUSY set by a write to CMD_REG by the Atom, cleared by a write by the MCU
    // MMC_MCU_READ set by a write by the Atom (to any reg), cleared by a read by the MCU
    // MCU_MMC_WROTE set by a write by the MCU cleared by a read by the Atom (any reg except status).
    //
        #define MMC_MCU_BUSY		0x01
        #define MMC_MCU_READ		0x02
        #define MMC_MCU_WROTE		0x04

        */

// const cmd = {
//     0x00: "CMD_REG",
//     0x01: "LATCH_REG",
//     0x02: "READ_DATA_REG",
//     0x03: "WRITE_DATA_REG",
//     0x04: "STATUS_REG",
// };
// const status = {
//     0x4f: "STATUS_OK",
//     0x40: "STATUS_COMPLETE",
//     0x60: "STATUS_EOF",
//     0x80: "STATUS_BUSY",
// };

export function extractSDFiles(data) {
    var unzip = new jsunzip.JSUnzip();
    // console.log("Attempting to unzip");
    var result = unzip.open(data);
    if (!result.status) {
        throw new Error("Error unzipping ", result.error);
    }
    var uncompressedFiles = [];
    var loadedFiles = [];

    for (var f in unzip.files) {
        var match = f.match(/^[a-z./]+/i);
        // console.log("m "+match);
        if (!match) {
            console.log("Skipping file", f);
            continue;
        }
        // console.log("Adding file", f);
        uncompressedFiles.push(unzip.read(f));
        loadedFiles.push("/" + f);
    }
    console.log("Uncompressed files: ", uncompressedFiles.length);
    return { uFiles: uncompressedFiles, names: loadedFiles };
}

export async function LoadSD(file) {
    const data = await utils.loadData(file);
    return extractSDFiles(data);
}

export class AtomMMC2 {
    attachGamepad(gamepad) {
        this.gamepad = gamepad;
    }

    // the CPU is resetting the MMC
    reset(hard) {
        if (hard) {
            // could store this to an EE file
            // EEPROM is 0xFF initially
            this.configByte = 0xff; //eeprom[EE_SYSFLAGS];
        }
        this.CWD = "";
    }

    // Set the MMC data, which is the unzipped files
    SetMMCData(data) {
        this.MMCdata = data;
    }

    constructor(cpu) {
        this.cpu = cpu;
        this.MMCdata = undefined; // will be set by SetMMCData
        this.gamepad = null;
        this.MMCtoAtom = STATUS_BUSY;
        this.heartbeat = 0x55;
        this.MCUStatus = MMC_MCU_BUSY;
        this.configByte = 0; /// EEPROM
        this.byteValueLatch = 0;
        this.globalData = new Uint8Array(256);
        this.globalIndex = 0;
        this.globalDataPresent = 0;
        this.filenum = -1;
        this.worker = null;
        this.WildPattern = ".*";
        this.foldersSeen = [];
        this.dfn = 0;
        this.fildata = null;
        this.fildataIndex = 0;
        this.TRISB = 0;
        this.PORTB = 0;
        this.LATB = 0;
        this.CWD = "";
        this.reset(true);
    }

    WFN_WorkerTest() {
        console.log("WFN_WorkerTest");
    }

    fileOpen(mode) {
        // no data available
        if (this.MMCdata === undefined) return 4; // no file

        var ret = 0;
        if (this.filenum === 0) {
            // spread operator '...'
            var fname = String.fromCharCode(...this.globalData.slice(0, -1)).split("\0")[0];
            fname = "/" + fname;
            if (this.CWD.length > 0) fname = this.CWD + fname;
            console.log("FileOpen " + fname + " mode " + mode);
            // The scratch file is fixed, so we are backwards compatible with 2.9 firmware
            this.fildata = new Uint8Array();
            this.fildataIndex = 0;
            //ret = f_open(&fildata[0], (const char*)globalData, mode);
            ret = 4; //FR_NO_FILE

            // search to see if this might be a directory name
            var dirname = fname + "/";
            var result = this.MMCdata.names.findIndex((file) => {
                return file.startsWith(dirname);
            }, dirname);
            var a = this.MMCdata.names.indexOf(fname);
            if (result !== -1) {
                ret = 8; //FR_EXISTS
            } else if (a !== -1) {
                this.fildata = this.MMCdata.uFiles[a].data;
                ret = 0; //FR_OK
            }
            // } else {
            //     // If a random access file is being opened, search for the first available FIL
            //     this.filenum = 0;
            //     if (!fildata[1].fs) {
            //         this.filenum = 1;
            //     } else if (!fildata[2].fs) {
            //         this.filenum = 2;
            //     } else if (!fildata[3].fs) {
            //         this.filenum = 3;
            //     }
            //     if (this.filenum > 0) {
            //         // ret = f_open(&fildata[this.filenum], (const char*)globalData, mode);
            //         // if (!ret) {
            //             // No error, so update the return value to indicate the file num
            //             // ret = FILENUM_OFFSET | filenum;
            //         // }
            //     } else {
            //         // All files are open, return too many open files
            //         ret = ERROR_TOO_MANY_OPEN;
            //     }
        }
        return STATUS_COMPLETE | ret;
    }

    WFN_FileOpenRead() {
        console.log("WFN_FileOpenRead " + this.filenum);

        var res = this.fileOpen(FA_OPEN_EXISTING | FA_READ);
        // if (this.filenum < 4) {
        //     // FILINFO *filinfo = &filinfodata[this.filenum];
        //     get_fileinfo_special(filinfo);
        // }
        this.WriteDataPort(STATUS_COMPLETE | res);
    }

    WFN_FileOpenWrite() {
        console.log("WFN_FileOpenWrite " + this.filenum + " not implemented yet");
        //   WriteDataPort(STATUS_COMPLETE | fileOpen(FA_CREATE_NEW|FA_WRITE));
    }

    WFN_FileClose() {
        console.log("WFN_FileClose " + this.filenum);
        // FIL *fil = &fildata[filenum];
        // WriteDataPort(STATUS_COMPLETE | f_close(fil));
        this.WriteDataPort(STATUS_COMPLETE);
    }

    WFN_DirectoryOpen() {
        var path = String.fromCharCode(...this.globalData.slice(0, -1)).split("\0")[0];
        if (this.CWD.length > 0) path = this.CWD + path;
        else if (path !== "") path = "/" + path;

        this.globalData = new TextEncoder("utf-8").encode(path + "\0");

        console.log("WFN_DirectoryOpen : " + path);

        // found a wildcard but no final '/' then just use wildcard
        // found a final / followed by wildcard, set path and wildcard

        this.WildPattern = ".*";
        this.foldersSeen = [];
        // GetWildcard(); // into globaldata

        var res = 0; // FR_OK
        path += "/";
        // globaldata is the wildcard for the getting the director
        // res = f_opendir(&dir, (const char*)globalData);
        var result = this.MMCdata.names.findIndex((file) => {
            return file.startsWith(path);
        }, path);
        this.openeddir = "";
        if (result === -1)
            res = 5; //FR_NO_PATH
        else this.openeddir = path;

        this.dfn = 0;

        if (this.MMCdata === undefined) res = 4; //FR_ERROR

        // if (this.FR_OK != res)
        if (0 !== res) {
            this.WriteDataPort(STATUS_COMPLETE | res);
            return;
        }

        this.WriteDataPort(STATUS_OK);
    }

    WFN_DirectoryRead() {
        console.log("WFN_DirectoryRead : ");

        while (true) {
            if (
                this.MMCdata === undefined ||
                this.MMCdata.names[this.dfn] === undefined ||
                this.MMCdata.names.length === 0
            ) {
                // done
                var res = 0; // no error just empty
                this.WriteDataPort(STATUS_COMPLETE | res);
                // console.log("WFN_DirectoryRead STATUS_COMPLETE");
                return;
            }

            var longname = this.MMCdata.names[this.dfn];
            var cwd = new RegExp("^" + this.openeddir); // ,'i'); for case insensitive

            // skip any file that doesn't begin with the CWD (beginning with /)
            var dirmatch = longname.match(cwd);
            if (!dirmatch) {
                this.dfn += 1;
                continue;
            }

            longname = longname.replace(cwd, "");

            var folders = longname.split("/");
            var fname = folders[0];
            var isdir = folders.length > 1;
            var Match = fname.match(new RegExp(this.WildPattern));

            var seenAlready = isdir && this.foldersSeen.includes(fname);

            if (!Match || seenAlready) {
                this.dfn += 1;
                continue;
            }

            var str = "";
            // check for dir
            if (isdir) {
                // its a directory name
                str += "<";
            }

            // str+=this.MMCdata.names[this.dfn];
            str += fname;
            if (isdir) {
                // its a directory name
                str += ">";
                this.foldersSeen.push(fname);
            }

            console.log("WFN_DirectoryRead STATUS_OK  " + str);
            this.WriteDataPort(STATUS_OK);
            this.globalData = new TextEncoder("utf-8").encode(str + "\0");

            this.dfn += 1;
            return;
        }
    }

    WFN_SetCWDirectory() {
        var dirname = String.fromCharCode(...this.globalData.slice(0, -1)).split("\0")[0];

        console.log("WFN_SetCWDirectory " + dirname);
        //this.WriteDataPort(STATUS_COMPLETE | f_chdir((const XCHAR*)globalData));
        if (dirname === "/" || dirname === "") {
            this.CWD = "";
        } else if (dirname === ".") {
            console.log("set to .");
        } else if (dirname === "..") {
            var dirs = this.CWD.split("/");
            dirs.pop(); // remove right
            if (dirs.length > 1) this.CWD = "/" + dirs.join("/");
            else this.CWD = "";
        } else if (dirname[0] === "/") {
            this.CWD = dirname;
        } else {
            this.CWD += "/" + dirname;
        }
        this.WriteDataPort(STATUS_COMPLETE);
    }

    WFN_FileSeek() {
        console.log("WFN_FileSeek " + this.filenum + " not implemented yet");

        //           FIL *fil = &fildata[filenum];

        //    union
        //    {
        //       DWORD dword;
        //       char byte[4];
        //    }
        //    dwb;

        //    dwb.byte[0] = globalData[0];
        //    dwb.byte[1] = globalData[1];
        //    dwb.byte[2] = globalData[2];
        //    dwb.byte[3] = globalData[3];

        //    WriteDataPort(STATUS_COMPLETE | f_lseek(fil, dwb.dword));
    }

    WFN_FileRead() {
        // ÷        console.log("WFN_FileRead : ");

        if (this.globalAmount === 0) {
            this.globalAmount = 256;
        }

        var read = Math.min(this.fildata.length, this.globalAmount);
        var fildataEnd = this.fildataIndex + read;
        var data = this.fildata.slice(this.fildataIndex, fildataEnd);
        // console.log("WFN_FileRead " + this.fildataIndex + " .read " + read + " .datalen " + data.length);

        //fildata
        //int ret;
        var ret;
        //FIL *fil = &fildata[this.filenum];
        //UINT read;
        //ret = f_read(fil, globalData, globalAmount, &read);
        //fil = &fildata[filenum];
        ret = 0;

        this.globalData = data;
        this.fildataIndex = fildataEnd;

        if (this.filenum > 0 && ret === 0 && this.globalAmount !== read) {
            this.WriteDataPort(STATUS_EOF); // normal file
        } else {
            // scratch file
            this.WriteDataPort(STATUS_COMPLETE | ret);
        }
    }

    WFN_FileWrite() {
        console.log("WFN_FileWrite");
        //   FIL *fil = &fildata[filenum];
        //    UINT written;
        //    if (globalAmount == 0)
        //    {
        //       globalAmount = 256;
        //    }

        //    WriteDataPort(STATUS_COMPLETE | f_write(fil, (void*)globalData, globalAmount, &written));
    }

    WFN_ExecuteArbitrary() {
        console.log("WFN_ExecuteArbitrary");
    }

    WFN_FileOpenRAF() {
        console.log("WFN_FileOpenRAF " + this.filenum + " not implemented yet");
        //    WriteDataPort(STATUS_COMPLETE | fileOpen(FA_OPEN_ALWAYS|FA_WRITE));
    }
    WFN_FileDelete() {
        console.log("WFN_FileDelete " + this.filenum + " not implemented yet");
        //    WriteDataPort(STATUS_COMPLETE | f_unlink((const XCHAR*)&globalData[0]));
    }
    WFN_FileGetInfo() {
        console.log("WFN_FileGetInfo " + this.filenum + " not implemented yet");
        //    FIL *fil = &fildata[filenum];
        //    FILINFO *filinfo = &filinfodata[filenum];
        //    union
        //    {
        //       DWORD dword;
        //       char byte[4];
        //    }
        //    dwb;

        //    dwb.dword = fil->fsize;
        //    globalData[0] = dwb.byte[0];
        //    globalData[1] = dwb.byte[1];
        //    globalData[2] = dwb.byte[2];
        //    globalData[3] = dwb.byte[3];

        //    dwb.dword = (DWORD)(fil->org_clust-2) * fatfs.csize + fatfs.database;
        //    globalData[4] = dwb.byte[0];
        //    globalData[5] = dwb.byte[1];
        //    globalData[6] = dwb.byte[2];
        //    globalData[7] = dwb.byte[3];

        //    dwb.dword = fil->fptr;
        //    globalData[8] = dwb.byte[0];
        //    globalData[9] = dwb.byte[1];
        //    globalData[10] = dwb.byte[2];
        //    globalData[11] = dwb.byte[3];

        //    globalData[12] = filinfo->fattrib & 0x3f;

        //    WriteDataPort(STATUS_OK);
    }

    // MMCtoAtom and MCUStatus are used to transfer data
    // from the MMC to the Atom and vice versa.

    // Set the WROTE bit and write data to the Atom
    WriteDataPort(b) {
        this.MMCtoAtom = b;
        this.MCUStatus &= ~MMC_MCU_BUSY;
        this.MCUStatus |= MMC_MCU_WROTE;
    }

    // Set the WROTE bit and return the data from the Atom
    ReadDataPort() {
        this.MCUStatus &= ~MMC_MCU_READ;
        this.MCUStatus |= MMC_MCU_WROTE;

        return this.MMCtoAtom;
    }

    // CPU is writing to 0xb400-0xb40c
    write(addr, val) {
        // begin a write operation to the MMC

        // console.log("WriteMMC 0x" + addr.toString(16) + " <- 0x" + val.toString(16));
        this.lastaddr = addr;
        this.at_process(addr, val, true);
    }

    // CPU is reading from 0xb400-0xb40c
    read(addr) {
        // the get the value from the MMC as it is now
        var Current = this.MMCtoAtom;
        var val = Current & 0xff;
        var reg = addr & 0x0f;
        var stat = this.MCUStatus;

        // set the read bit
        this.MCUStatus &= ~MMC_MCU_READ;

        // ignore the current addr; use the last write address
        addr = this.lastaddr;

        // reading the MMC status register (returns the status)
        // or a a value written to the port
        if (reg === STATUS_REG) {
            // console.log("ReadMMC STATUS_REG : 0x" + (addr & 0x0f).toString(16) + " -> val 0x" + stat.toString(16));
            // status REG from MCUStatus
            return stat;
        }
        // else if (val in status) console.log("ReadMMC " + cmd[reg] + " -> " + status[val]);
        // else console.log("ReadMMC " + cmd[reg] + " -> 0x" + val.toString(16));

        // reading, but process the read before returning the value
        this.at_process(addr, val, false);

        return Current;
    }
    // Depending on the addr, that will say what command is required.
    // If it is a write, then the data will be ReadDataPort from Atom.
    // If it is a read, (via READ_DATA_REG) then the data will be written to Atom via WriteDataPort.
    at_process(addr, val, write) {
        let LatchedAddress = addr & 0x0f;
        const ADDRESS_MASK = 0x07;

        // console.log("at_process "+write+" 0x"+addr.toString(16)+" <- 0x"+val.toString(16));

        this.worker = null;

        // ser the read bit
        this.MCUStatus |= MMC_MCU_READ;

        // if reading then need to set the data into DataPort
        if (write === false) {
            // clear the read bit
            this.MCUStatus &= ~MMC_MCU_READ;
            // IGNORE addr for 'read' it is just the last addr
            switch (LatchedAddress) {
                case READ_DATA_REG: {
                    // var received = val & 0xff;
                    var q = this.globalIndex;
                    var dd = 0;
                    if (q < this.globalData.length) dd = this.globalData[q] | 0;
                    // console.log("read READ_DATA_REG 0x" + dd.toString(16) + ", index " + q);
                    this.WriteDataPort(dd);
                    ++this.globalIndex;

                    break;
                }
            }
        } else {
            switch (LatchedAddress & ADDRESS_MASK) {
                case CMD_REG:
                    var received = val & 0xff;

                    // File Group 0x10-0x17, 0x30-0x37, 0x50-0x57, 0x70-0x77
                    // filenum = bits 6,5
                    // mask1 = 10011000 (test for file group command)
                    // mask2 = 10011111 (remove file number)
                    if ((received & 0x98) === 0x10) {
                        this.filenum = (received >> 5) & 3;
                        received &= 0x9f;
                    }

                    // Data Group 0x20-0x23, 0x24-0x27, 0x28-0x2B, 0x2C-0x2F
                    // filenum = bits 3,2
                    // mask1 = 11110000 (test for data group command)
                    // mask2 = 11110011 (remove file number)
                    if ((received & 0xf0) === 0x20) {
                        this.filenum = (received >> 2) & 3;
                        received &= 0xf3;
                    }

                    // console.log(
                    //     "CMD_REG 0x" +
                    //         (addr & 0x0f).toString(16) +
                    //         " <- received 0x" +
                    //         received.toString(16) +
                    //         " filenum : " +
                    //         this.filenum,
                    // );

                    this.WriteDataPort(STATUS_BUSY);
                    this.MCUStatus |= MMC_MCU_BUSY;

                    // Directory group, moved here 2011-05-29 PHS.
                    //
                    if (received === CMD_DIR_OPEN) {
                        // reset the directory reader
                        //
                        // when 0x3f is read back from this register it is appropriate to
                        // start sending cmd 1s to get items.
                        //
                        this.worker = this.WFN_DirectoryOpen;
                    } else if (received === CMD_DIR_READ) {
                        // get next directory entry
                        //
                        this.worker = this.WFN_DirectoryRead;
                    } else if (received === CMD_DIR_CWD) {
                        // set CWD
                        //
                        this.worker = this.WFN_SetCWDirectory;
                    }

                    // File group.
                    //
                    else if (received === CMD_FILE_CLOSE) {
                        // close the open file, flushing any unwritten data
                        //
                        this.worker = this.WFN_FileClose;
                    } else if (received === CMD_FILE_OPEN_READ) {
                        // open the file with name in global data buffer
                        //
                        this.worker = this.WFN_FileOpenRead;
                    } else if (received === CMD_FILE_OPEN_WRITE) {
                        // open the file with name in global data buffer for write
                        //
                        this.worker = this.WFN_FileOpenWrite;
                    }

                    // SP9 START
                    else if (received === CMD_FILE_OPEN_RAF) {
                        // open the file with name in global data buffer for write/append
                        //
                        this.worker = this.WFN_FileOpenRAF;
                    }

                    // SP9 END
                    else if (received === CMD_FILE_DELETE) {
                        // delete the file with name in global data buffer
                        //
                        this.worker = this.WFN_FileDelete;
                    }

                    // SP9 START
                    else if (received === CMD_FILE_GETINFO) {
                        // return file's status byte
                        //
                        this.worker = this.WFN_FileGetInfo;
                    } else if (received === CMD_FILE_SEEK) {
                        // seek to a location within the file
                        //
                        this.worker = this.WFN_FileSeek;
                    }

                    // SP9 END
                    else if (received === CMD_INIT_READ) {
                        // All data read requests must send CMD_INIT_READ before beggining reading
                        // data from READ_DATA_PORT. After execution of this command the first byte
                        // of data may be read from the READ_DATA_PORT.
                        //
                        console.log(
                            "CMD_INIT_READ: READ_DATA_REG 0x" + this.globalData[0].toString(16) + ", index " + 0,
                        );
                        this.WriteDataPort(this.globalData[0]);
                        this.globalIndex = 1;
                        // LatchedAddress
                        this.lastaddr = READ_DATA_REG;
                    } else if (received === CMD_INIT_WRITE) {
                        // console.log("CMD_INIT_WRITE");
                        // all data write requests must send CMD_INIT_WRITE here before poking data at
                        // WRITE_DATA_REG
                        // globalDataPresent is a flag to indicate whether data is present in the bfr.
                        //
                        this.globalData = new Uint8Array(256);
                        this.globalIndex = 0;
                        this.globalDataPresent = 0;
                    } else if (received === CMD_READ_BYTES) {
                        // Replaces READ_BYTES_REG
                        // Must be previously written to latch reg.
                        this.globalAmount = this.byteValueLatch;
                        this.worker = this.WFN_FileRead;
                    } else if (received === CMD_WRITE_BYTES) {
                        // replaces WRITE_BYTES_REG
                        // Must be previously written to latch reg.
                        this.globalAmount = this.byteValueLatch;
                        this.worker = this.WFN_FileWrite;
                    }

                    //
                    // Exec a packet in the data buffer.
                    else if (received === CMD_EXEC_PACKET) {
                        this.worker = this.WFN_ExecuteArbitrary;
                    } else if (received === CMD_GET_FW_VER) {
                        // read firmware version
                        this.WriteDataPort((VSN_MAJ << 4) | VSN_MIN);
                    } else if (received === CMD_GET_BL_VER) {
                        // read bootloader version
                        this.WriteDataPort(1); //(blVersion);
                    } else if (received === CMD_GET_CFG_BYTE) {
                        // read config byte
                        console.log("CMD_REG:CMD_GET_CFG_BYTE -> 0x" + this.configByte.toString(16));
                        this.WriteDataPort(this.configByte);
                    } else if (received === CMD_SET_CFG_BYTE) {
                        // write config byte
                        this.configByte = this.byteValueLatch;

                        console.log("CMD_REG:CMD_SET_CFG_BYTE -> 0x" + this.configByte.toString(16));
                        //                                WriteEEPROM(EE_SYSFLAGS, this.configByte);
                        this.WriteDataPort(STATUS_OK);
                    } else if (received === CMD_READ_AUX) {
                        // read porta - latch & aux pin on dongle
                        this.WriteDataPort(this.LatchedAddress);
                    } else if (received === CMD_GET_HEARTBEAT) {
                        // console.log("CMD_REG:CMD_GET_HEARTBEAT -> 0x" + this.heartbeat.toString(16));
                        this.WriteDataPort(this.heartbeat);
                        this.heartbeat ^= 0xff;
                    }
                    //
                    // Utility commands.
                    // Moved here 2011-05-29 PHS
                    else if (received === CMD_GET_CARD_TYPE) {
                        // console.log("CMD_REG:CMD_GET_CARD_TYPE -> 0x01");
                        // get card type - it's a slowcmd despite appearance
                        // disk_initialize(0);
                        //#define CT_MMC 0x01 /* MMC ver 3 */
                        this.WriteDataPort(0x01);
                    }

                    // support for PORTs but really doing nothing!
                    else if (received === CMD_GET_PORT_DDR) {
                        // get portb direction register
                        this.WriteDataPort(this.TRISB);
                    } else if (received === CMD_SET_PORT_DDR) {
                        // set portb direction register
                        this.TRISB = this.byteValueLatch;

                        // this.WriteEEPROM(EE_PORTBTRIS, this.byteValueLatch);
                        this.WriteDataPort(STATUS_OK);
                    } else if (received === CMD_READ_PORT) {
                        // read portb
                        // SP3 JOYSTICK SUPPORT
                        var JOYSTICK = 0xff;
                        var joyst = true;
                        if (joyst && this.gamepad && this.gamepad.gamepadButtons !== undefined) {
                            if (this.gamepad.gamepadButtons[15])
                                //right
                                JOYSTICK ^= 1;
                            if (this.gamepad.gamepadButtons[14])
                                //left
                                JOYSTICK ^= 2;
                            if (this.gamepad.gamepadButtons[13])
                                //down
                                JOYSTICK ^= 4;
                            if (this.gamepad.gamepadButtons[12])
                                //up
                                JOYSTICK ^= 8;
                            if (this.gamepad.gamepadButtons[0])
                                // Fire
                                JOYSTICK ^= 0x10;

                            this.WriteDataPort(JOYSTICK);
                        } else {
                            this.WriteDataPort(this.PORTB);
                        }

                        // END SP3
                    } else if (received === CMD_WRITE_PORT) {
                        // write port B value
                        this.LATB = this.byteValueLatch;

                        // this.WriteEEPROM(EE_PORTBVALU, byteValueLatch);
                        this.WriteDataPort(STATUS_OK);
                    } else {
                        console.log("unrecognised CMD: " + received);
                    }

                    break;

                case WRITE_DATA_REG: {
                    // move data from the Atom to the MMC (i.e. Atom is trying to Write)
                    let received = val & 0xff;

                    // console.log("WRITE_DATA_REG  <- " + this.globalIndex + ", received 0x" + received.toString(16));

                    this.globalData[this.globalIndex] = received;

                    ++this.globalIndex;

                    this.globalDataPresent = 1;
                    break;
                }

                case LATCH_REG: {
                    // latch the value from the MMC to the Atom (i.e. Atom is trying to read)
                    let received = val & 0xff;
                    // console.log(
                    //     "LATCH_REG 0x" + (addr & 0x0f).toString(16) + " <- received 0x" + received.toString(16),
                    // );
                    this.byteValueLatch = received;
                    this.WriteDataPort(this.byteValueLatch);
                    break;
                }
                case STATUS_REG: {
                    // does nothing
                    // var received = val & 0xff;
                    // console.log(
                    //     "STATUS_REG 0x" + (addr & 0x0f).toString(16) + " <- received 0x" + received.toString(16),
                    // );
                }
            }

            if (this.worker) {
                this.worker();
            }
        }
    }
}
