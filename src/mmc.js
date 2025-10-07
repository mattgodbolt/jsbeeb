"use strict";
import * as utils from "./utils.js";
import "./lib/jszip.min.js"; // https://stuk.github.io/jszip/

/* global JSZip */

/*
highly adapted from:
https://github.com/hoglet67/Atomulator
in the src/atommc folder

Simulate the AtoMMC2 device, which is a MMC/SD card reader for the Acorn Atom.

First create a dictionary of the MMC data from a zipped file, into this.allfiles.

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
// const CMD_DIR_GETCWD = 0x3;
const CMD_DIR_MKDIR = 0x4;
const CMD_DIR_RMDIR = 0x5;

const CMD_RENAME = 0x8;

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
const FA_WRITE = 2;
const FA_CREATE_NEW = 4;

// Simulate constants
const FR_OK = 0,
    FR_EXIST = 8,
    FR_NO_FILE = 4,
    FR_NO_PATH = 5,
    FR_INVALID_NAME = 6;
const FA_CREATE_ALWAYS = 8,
    FA_OPEN_ALWAYS = 16,
    ERROR_TOO_MANY_OPEN = 0x12,
    FILENUM_OFFSET = 0x20;
// Simulate open modes
const O_CREAT = 0x100,
    O_RDWR = 0x2,
    O_RDONLY = 0x0,
    O_BINARY = 0x8000;

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

/** WFN functions
 *
 */
/**
 * Represents a file with a path and data.
 */
export class WFNFile {
    /**
     * @param {string} path - The file path. prepended with § if deleted
     * @param {Uint8Array} data - The file data.
     */
    constructor(path, data) {
        this.path = path;
        this.data = data instanceof Uint8Array ? data : new Uint8Array();
    }
}

export async function toMMCZipAsync(data) {
    const newzip = new JSZip();

    // loop and enumerate data
    for (let i = 0; i < data.length; i++) {
        const name = data[i].path;
        const file = data[i].data;

        if (name.startsWith("§"))
            //unlinked file
            continue;
        // remove leading /
        const zipName = name.startsWith("/") ? name.slice(1) : name;

        console.log("adding to zip: " + zipName);
        newzip.file(zipName, file);
    }

    const zipfile = await newzip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        platform: "UNIX",
    });

    return zipfile;
}

export async function extractSDFiles(data) {
    const newunzip = new JSZip();
    const unzip = await newunzip.loadAsync(data);

    // Collect all promises for file extraction
    const filePromises = [];
    const unzippedfiles = [];

    for (const f in unzip.files) {
        // only unzip files with names that have a-z, ., or / (case insensitive)
        const match = f.match(/^[a-z./]+/i);
        if (!match) {
            console.log("Skipping file: ", fileObj);
            continue;
        }
        // Push a promise that resolves when the file is extracted
        const fileObj = unzip.files[f];
        const promise = fileObj.async("uint8array").then((fileData) => {
            // push the data and the filename
            unzippedfiles.push(new WFNFile("/" + f, fileData));
        });
        filePromises.push(promise);
    }

    // Wait for all files to be extracted
    await Promise.all(filePromises);

    return unzippedfiles;
}

export async function LoadSD(file) {
    const data = await utils.loadData(file);
    return extractSDFiles(data);
}

class WFN {
    /**
     * Create a new WFN instance.
     * @param {Object} cpu - The CPU instance.
     */
    constructor(mmc, cpu) {
        this.mmc = mmc;
        this.cpu = cpu;

        this.globalData = new Uint8Array(256);
        this.globalIndex = 0;
        this.globalDataPresent = 0;
        this.globalAmount = 0;

        this.fildata = new Array(4).fill(null);
        this.fildataIndex = 0;

        this.openeddir = ""; // Directory requested when reading directories
        this.foldersSeen = []; // Folders seen when reading directories
        this.dfn = 0; // Directory file number, used to track the current file in the zip file when reading directories

        this.CWD = "";

        this.filenum = -1;
        this.seekpos = 0;
        this.WildPattern = ".*"; // Default wildcard pattern (for regex not ATOM)

        /**
         * @type {WFNFile[]}
         */
        this.allfiles = [];
    }

    WFN_WorkerTest() {
        console.log("WFN_WorkerTest");
    }

    WFN_FileOpenRead() {
        console.log(`WFN_FileOpenRead ${this.filenum}`);
        const res = this.fileOpen(FA_OPEN_EXISTING | FA_READ);
        // if (filenum < 4) {
        //      FILINFO *filinfo = &filinfodata[filenum];
        //     get_fileinfo_special(filinfo);
        // }
        this.mmc.WriteDataPort(STATUS_COMPLETE | res);
    }

    WFN_FileOpenWrite() {
        console.log(`WFN_FileOpenWrite ${this.filenum}`);
        console.log(`filename   ${String.fromCharCode(...this.globalData)} `);
        const res = this.fileOpen(FA_CREATE_NEW | FA_WRITE);
        this.mmc.WriteDataPort(STATUS_COMPLETE | res);
    }

    WFN_FileClose() {
        console.log(`WFN_FileClose ${this.filenum}`);
        this.seekpos = 0;
        this.mmc.WriteDataPort(STATUS_COMPLETE);
    }

    GetWildcard() {
        // Extract the path from this.globalData (Uint8Array) until the first null byte
        let path = this.trimToFilename(this.globalData);

        // haswildcard is true if the path contains a wildcard character ('*' or '?')
        let hasWildcard = path.includes("*") || path.includes("?");

        path = path.replace(/\\/g, "/"); // Normalize path separators
        let hasSlash = path.includes("/");

        if (hasWildcard) {
            if (hasSlash) {
                // globaldata will have  everything up until the last slash
                let lastSlashIndex = path.lastIndexOf("/");
                this.globalData = path.slice(0, lastSlashIndex + 1);
                this.WildPattern = path.slice(lastSlashIndex + 1);
            } else {
                // posix regex is .+ (1 or more characters) or . (exactly 1 character)
                this.WildPattern = path.replace(/\*/g, ".+").replace(/\?/g, ".");

                this.globalData = "";
            }
        } else {
            // No wildcard, just return the path
            this.WildPattern = ".*";
        }
    }

    // Strip trailing slash from a path string
    stripTrailingSlash(path) {
        if (path.endsWith("/")) {
            return path.slice(0, -1);
        }
        return path;
    }

    /*
    MMCData file contains only files with paths, and no directories.
    To simulate directories, a basepath with multiple entries is a directory
    For example, if the MMCData file contains:
    /dir1/file1.txt
    /dir1/file2.txt
    /dir2/file3.txt
    then /dir1/ is a directory, and /dir2/ is a directory.
    The findfirst and findnext functions will simulate directory traversal by checking the paths in allfiles.
    The findfirst function will set this.dfn to the index of the first file in the directory, and this.openeddir to the directory path.
    The findnext function will iterate through the files in the directory, checking if the file path starts with this.openeddir.
    If a file path starts with this.openeddir, it is considered to be in the directory.
    If a file path does not start with this.openeddir, it is considered to be outside the directory.
    If a file path has a subdirectory (i.e., it contains a slash after the directory path), it is considered to be in a subdirectory and is returned
    once and subsequent calls to findnext will skip it.



    */

    // Simulate findfirst: check if a directory exists in allfiles
    findfirst(path) {
        const dirPrefix = this.stripTrailingSlash(path) + "/"; // Ensure path ends with a slash

        // Simulate directory open: check if any file starts with path + "/"
        const f_index = this.allfiles.findIndex((file) => file.path.startsWith(dirPrefix));

        // if index is found, set dfn to the index of the first file in the directory
        if (f_index !== -1) {
            this.dfn = f_index + 1; // Set dfn to the next entry after the first one in this directory
            this.openeddir = dirPrefix; // record the opened directory
        }

        this.foldersSeen = [];

        return f_index !== -1;
    }

    // this.dfn is the index of the next file in the zip file

    // Simulate findnext: iterate through directory entries in allfiles[].path
    findnext() {
        let foundDirEntry = "";
        do {
            // entry = readdir()

            if (this.dfn >= this.allfiles.length) break;

            // Check if the next file starts with the opened directory
            const nextFullName = this.allfiles[this.dfn].path;
            //

            if (!nextFullName.startsWith(this.openeddir)) {
                this.dfn += 1;
                continue; // Skip to the next entry if it doesn't match the opened directory
            }

            let relativeName = nextFullName.slice(this.openeddir.length);

            // Skip empty or root entries
            if (relativeName === "" && relativeName !== "/") {
                this.dfn += 1;
                continue; // Skip to the next entry if it doesn't match the opened directory
            }

            //
            let folders = relativeName.split("/");

            relativeName = folders[0];

            // skip files in subdirectories if the subdirecty has been seen before
            if (folders.length > 1) {
                if (this.foldersSeen.includes(folders[0])) {
                    // If this is seen subfolder, skip this entry
                    this.dfn += 1;
                    continue;
                }
                this.foldersSeen.push(folders[0]);
                relativeName = folders[0] + "/"; // relative name is the folder + slash
            }
            foundDirEntry = relativeName;
        } while (foundDirEntry == "");

        if (foundDirEntry) {
            // Optionally, check for valid 8.3 filename here if needed
            // For now, just return the entry
            this.dfn += 1;
            return foundDirEntry;
        }

        // No more entries
        return "";
    }

    // Simulate f_opendir: open a directory
    f_opendir(path) {
        // Build absolute path and check validity
        const xpath = this.trimToFilename(path);
        const absResult = this.buildAbsolutePath(xpath, false);
        if (absResult.error) {
            return absResult.error;
        }
        const newpath = absResult.path;

        if (this.findfirst(newpath)) {
            return FR_OK;
        } else {
            return FR_NO_PATH;
        }
    }

    WFN_DirectoryOpen() {
        // Separate wildcard and path
        this.GetWildcard();

        let res = this.f_opendir(this.globalData);
        this.dfn = 0;
        if (res !== 0) {
            this.mmc.WriteDataPort(STATUS_COMPLETE | res);
            return;
        }
        this.mmc.WriteDataPort(STATUS_OK);
    }

    f_readdir() {
        let fno = { fname: "", fsize: 0, fattrib: 0 };
        // If a file found copy it's details, else set size to 0 and filename to ''
        const nextentry = this.findnext();
        fno.fname = nextentry;

        return { error: FR_OK, fno: fno };
    }

    WFN_DirectoryRead() {
        console.log("WFN_DirectoryRead : ");
        while (true) {
            let result = this.f_readdir();
            let res = result.error;

            if (res !== FR_OK || result.fno.fname === "") {
                this.mmc.WriteDataPort(STATUS_COMPLETE | res);
                return;
            }

            const fname = result.fno.fname;

            // Check to see if filename matches current wildcard
            // const Match = wildcmp(WildPattern, longname);
            const Match = fname.match(new RegExp(this.WildPattern));

            if (Match) {
                // if is a directory, str will be <fname>

                const isdir = fname.endsWith("/");
                let str = fname;
                if (isdir) {
                    str = str.slice(0, -1); // Remove trailing slash for directory names
                    str = `<${str}>`; // Enclose directory names in <>
                }

                console.log(`WFN_DirectoryRead STATUS_OK  ${str}`);

                // Convert the string to a Uint8Array
                this.globalData = new TextEncoder("utf-8").encode(str + "\0");

                this.mmc.WriteDataPort(STATUS_OK);
                return;
            }
        }
    }

    dir_exists(path) {
        // ensure path ends in slash
        if (!path.endsWith("/")) path += "/";

        // Check if the path exists in the names array
        if (this.allfiles.some((file) => file.path === path || file.path.startsWith(path))) {
            // Check if the path is a directory (ends with '/')
            return FR_OK;
        }
        return FR_NO_PATH;
    }

    realpath(path) {
        // In C, realpath resolves all symbolic links, relative paths, and returns the absolute path.
        // In JS, we just normalize the path (remove redundant slashes, resolve '.' and '..').
        // This is a simplified version and does not handle symlinks.
        const parts = [];
        for (const part of path.split("/")) {
            if (part === "" || part === ".") continue;
            if (part === "..") {
                if (parts.length > 0) parts.pop();
            } else {
                parts.push(part);
            }
        }
        path = "/" + parts.join("/");

        while (path.length > 0 && path.endsWith("/")) {
            path = path.slice(0, -1);
        }
        console.log("realpath " + path);
        return path;
    }

    f_chdir(path) {
        // ensure newpath is an absolute path (relative paths appended to CWD,
        // absolute paths are used as is)
        const newpath = this.buildAbsolutePath(path, false);
        if (newpath.error) {
            return newpath.error; // Return error if path is invalid
        }

        // Resolve the newpath
        const fullpath = this.realpath(newpath.path);
        if (fullpath !== undefined) {
            // Path exists and is a directory
            if (this.dir_exists(fullpath) == FR_OK) {
                this.CWD = fullpath; // Update the base path
                return FR_OK; // Success
            }
        }
        return FR_NO_PATH;
    }

    f_unlink(path) {
        // ensure newpath is an absolute path (relative paths appended to CWD,
        // absolute paths are used as is)
        const newpath = this.buildAbsolutePath(path, true);
        if (newpath.error) {
            return newpath.error; // Return error if path is invalid
        }

        // remove all in a folder, but this doesn't seem to be
        // used for *DELETE as files are deleted one by one
        if (this.dir_exists(newpath.path) == FR_OK) {
            // delete all the files within the folder
            this.allfiles
                .filter((file) => file.path.startsWith(newpath.path))
                .map((file) => (file.path = "§" + file.path));

            return FR_OK;
        }

        if (this.file_exists(newpath.path) == FR_OK) {
            // remove the file from the list
            this.allfiles.filter((file) => file.path == newpath.path).map((file) => (file.path = "§" + file.path));

            return FR_OK;
        }

        return FR_NO_PATH;
    }

    trimToFilename(globaldata) {
        let path = String.fromCharCode(...globaldata.slice(0, -1)).split("\0")[0];
        // when deleting folders, the pathname is echoed
        // back by the ATOM which means they have <...> around the
        // name
        if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1);
        return path;
    }

    WFN_SetCWDirectory() {
        const dirname = this.trimToFilename(this.globalData);
        console.log(`WFN_SetCWDirectory ${dirname}`);
        let ret = this.f_chdir(dirname);
        this.mmc.WriteDataPort(STATUS_COMPLETE | ret);
    }

    WFN_FileSeek() {
        console.log(`WFN_FileSeek ${this.filenum} not implemented yet`);
        this.seekpos =
            this.globalData[0] | (this.globalData[1] << 8) | (this.globalData[2] << 16) | (this.globalData[3] << 24);
        console.log(`    ${this.seekpos} not implemented yet`);
    }

    WFN_FileRead() {
        if (this.globalAmount === 0) {
            this.globalAmount = 256;
        }
        const read = Math.min(this.fildata[0].data.length, this.globalAmount);
        const fildataEnd = this.fildataIndex + read;
        const data = this.fildata[0].data.slice(this.fildataIndex, fildataEnd);
        let ret = 0;
        this.globalData = data;
        this.fildataIndex = fildataEnd;
        if (this.filenum > 0 && ret === 0 && this.globalAmount !== read) {
            this.mmc.WriteDataPort(STATUS_EOF);
        } else {
            this.mmc.WriteDataPort(STATUS_COMPLETE | ret);
        }
    }

    WFN_FileWrite() {
        let str = "";
        for (let i = 0; i < this.globalAmount; i++) {
            const code = this.globalData[i];
            str += code >= 32 && code <= 126 ? String.fromCharCode(code) : ".";
        }
        console.log(str);
        if (this.globalAmount === 0) {
            this.globalAmount = 256;
        }
        const wrote = this.globalAmount;
        const fildataEnd = this.fildataIndex + wrote;
        console.log(`WFN_FileWrite ${this.fildataIndex} .wrote ${wrote} .fildataEnd ${fildataEnd}`);

        // append this.globalData to this.fildata[0] at this.fildataIndex
        let oldData = this.fildata[0].data;
        let newLength = Math.max(oldData.length, fildataEnd);
        let newData = new Uint8Array(newLength);
        newData.set(oldData, 0);
        newData.set(this.globalData.slice(0, wrote), this.fildataIndex);
        this.fildata[0].data = newData;

        this.fildataIndex = fildataEnd;

        // const res = this.f_write(fil, (void*)globalData, globalAmount, &written);

        let res = 0; // always works !
        this.mmc.WriteDataPort(STATUS_COMPLETE | res);
    }

    WFN_ExecuteArbitrary() {
        console.log("WFN_ExecuteArbitrary");
    }

    WFN_FileOpenRAF() {
        console.log(`WFN_FileOpenRAF ${this.filenum} not implemented yet`);
    }
    WFN_FileDelete() {
        const pathname = this.trimToFilename(this.globalData);
        console.log(`WFN_FileDelete ${pathname}`);
        const ret = this.f_unlink(pathname);
        this.mmc.WriteDataPort(STATUS_COMPLETE | ret);
    }
    WFN_FileGetInfo() {
        console.log(`WFN_FileGetInfo ${this.filenum} not implemented yet`);
        this.mmc.WriteDataPort(STATUS_EOF);
    }

    WFN_DirectoryCreate() {
        const pathname = this.trimToFilename(this.globalData);
        console.log(`WFN_DirectoryCreate ${pathname} not implemented yet`);
        this.mmc.WriteDataPort(STATUS_EOF);
    }
    WFN_DirectoryDelete() {
        const pathname = this.trimToFilename(this.globalData);
        console.log(`WFN_DirectoryDelete ${pathname} not implemented yet`);
        this.mmc.WriteDataPort(STATUS_EOF);
    }
    WFN_Rename() {
        const pathname = this.trimToFilename(this.globalData);
        console.log(`WFN_Rename ${pathname} not implemented yet`);
        this.mmc.WriteDataPort(STATUS_EOF);
    }

    reset() {
        this.CWD = "";
    }

    clearData() {
        this.globalData = new Uint8Array(256);
        this.globalIndex = 0;
        this.globalDataPresent = 0;
    }

    addData(data) {
        this.globalData[this.globalIndex] = data;
        ++this.globalIndex;
        this.globalDataPresent = 1;
    }

    getData(restart = false) {
        if (restart) {
            this.globalIndex = 0;
            this.globalDataPresent = 0;
        }
        let val = 0;
        if (this.globalIndex < this.globalData.length) val = this.globalData[this.globalIndex] | 0;
        this.globalIndex++;
        return val;
    }

    setTransferLength(length) {
        this.globalAmount = length;
    }

    fileOpen(mode) {
        if (!this.allfiles) return 4; // no file
        let ret = 0;
        let fname = this.trimToFilename(this.globalData);
        console.log(`FileOpen ${fname} mode ${mode}`);

        if (this.filenum === 0) {
            this.fildataIndex = 0; // FIXME : should be one for each fildata if going down this line!
            // The scratch file is fixed, so we are backwards compatible with 2.9 firmware
            let fopen = this.f_open(fname, mode);
            if (fopen.error == FR_OK) this.fildata[0] = this.allfiles[fopen.fp];
            ret = fopen.error;
        } else {
            this.filenum = 0;
            if (this.fildata[1] === 0) {
                this.filenum = 1;
            } else if (this.fildata[2] === 0) {
                this.filenum = 2;
            } else if (this.fildata[3] === 0) {
                this.filenum = 3;
            }
            if (this.filenum > 0) {
                let fopen = this.f_open(fname, mode);
                if (fopen.error == FR_OK) {
                    this.fildata[this.filenum] = this.allfiles[fopen.fp];
                    // No error, so update the return value to indicate the file num
                    ret = FILENUM_OFFSET | this.filenum;
                }
            } else {
                // All files are open, return too many open files
                ret = ERROR_TOO_MANY_OPEN;
            }
        }
        return STATUS_COMPLETE | ret;
    }

    // Convert a path to an absolute, normalized path and optionally validate 8.3 filename
    buildAbsolutePath(xpath, validateName = true) {
        // Normalize path separators
        let path = String(xpath).replace(/\\/g, "/");

        // Optionally validate 8.3 filename rules
        if (validateName) {
            // Find the last element of the path
            let nameIdx = path.lastIndexOf("/");
            let name = nameIdx === -1 ? path : path.slice(nameIdx + 1);

            // Find the suffix
            let suffixIdx = name.indexOf(".");
            let namePart = suffixIdx !== -1 ? name.slice(0, suffixIdx) : name;
            let suffixPart = suffixIdx !== -1 ? name.slice(suffixIdx + 1) : "";

            // Validate the name part
            if (namePart.length < 1 || namePart.length > 8) {
                // Name not between 1 and 8 characters
                return { error: "FR_INVALID_NAME" };
            }

            // Validate the optional suffix part
            if (suffixIdx !== -1) {
                // Reject multiple suffixes
                if (suffixPart.includes(".")) {
                    return { error: "FR_INVALID_NAME" };
                }
                if (suffixPart.length === 0) {
                    // Remove a dangling suffix
                    path = path.slice(0, path.length - 1);
                } else if (suffixPart.length > 3) {
                    // Suffix too long
                    return { error: "FR_INVALID_NAME" };
                }
            }
        }

        // Make the path absolute
        let absPath;
        if (path.startsWith("/")) {
            // absolute: append the path to the root directory path
            absPath = path;
        } else {
            // relative: append the path to current directory path
            absPath = this.CWD + "/" + path; // CWD should be MMCPath
        }
        return { path: absPath };
    }

    // Check if a file exists in allfiles by name (returns FR_OK if exists, FR_NO_PATH if not)
    file_exists(name) {
        // if (!this.allfiles || !Array.isArray(this.allfiles)) return FR_NO_PATH;
        // Normalize name to absolute path
        const absResult = this.buildAbsolutePath(name, false);
        if (absResult.error) return FR_NO_PATH;
        const absName = absResult.path;
        // Search for a WFNFile with matching path (not a directory)
        const file = this.allfiles.find((f) => f.path === absName && !f.path.startsWith("§"));
        return file ? FR_OK : FR_NO_PATH;
    }

    open(path, mode) {
        let fileIndex = -1;
        if (this && this.allfiles) {
            fileIndex = this.allfiles.findIndex((f) => f.path === path);

            if (fileIndex === -1 && mode & O_CREAT) {
                // Create new file
                this.allfiles.push(new WFNFile(path, new Uint8Array()));
                fileIndex = this.allfiles.length - 1;
            } else if (fileIndex !== -1) {
                //cannot find file and not creating it.
            }
        }

        return fileIndex;
    }

    // Simulate f_open in JavaScript
    // Returns FR_OK (0) on success, or error code
    // fp: file object (JS object), path: string, mode: integer flags
    f_open(path, mode) {
        // Build absolute path and check validity
        const absResult = this.buildAbsolutePath(path, true);
        if (absResult.error) {
            return { error: FR_INVALID_NAME };
        }
        const open_path = absResult.path;

        // Check if file exists
        let exists = this.file_exists(open_path);

        // Mask mode flags
        mode &= FA_READ | FA_WRITE | FA_CREATE_ALWAYS | FA_OPEN_ALWAYS | FA_CREATE_NEW;

        let open_mode = 0;
        if (exists === FR_OK) {
            if (mode & FA_CREATE_NEW) return FR_EXIST;
            if (mode & FA_CREATE_ALWAYS) open_mode = O_CREAT;
            if (mode & (FA_READ | FA_WRITE)) {
                if (mode & FA_WRITE) open_mode |= O_RDWR;
                else open_mode |= O_RDONLY;
            }
        } else {
            if (mode & (FA_OPEN_ALWAYS | FA_CREATE_NEW | FA_CREATE_ALWAYS)) open_mode = O_CREAT | O_RDWR;
            else return { error: FR_NO_FILE };
        }

        // Simulate file open/create
        let fileIndex = this.open(open_path, open_mode | O_BINARY);

        if (fileIndex >= 0) {
            return { fp: fileIndex, error: FR_OK };
        } else {
            return { error: FR_INVALID_NAME };
        }
    }
}

/**
 * AtomMMC2 emulates the AtoMMC2 device for the Acorn Atom.
 * Handles SD/MMC file operations and communication with the Atom.
 */
export class AtomMMC2 {
    /**
     * Attach a gamepad object for joystick support.
     * @param {Object} gamepad
     */
    attachGamepad(gamepad) {
        this.gamepad = gamepad;
    }

    /**
     * Reset the MMC state.
     * @param {boolean} hard - If true, perform a hard reset.
     */
    reset(hard) {
        if (hard) {
            this.configByte = 0xff;
        }
        this.WFN.reset();
        this.seekpos = 0;
    }

    /**
     * Set the MMC data (unzipped files).
     * @param {Object} data
     */
    SetMMCData(data) {
        this.WFN.allfiles = data;
    }

    /**
     * Get the MMC data.
     * @returns {Object}
     */
    GetMMCData() {
        return this.WFN.allfiles;
    }

    /**
     * clear
     * @returns
     */
    ClearMMCData() {
        const fname = "README".padEnd(15, "\0");
        const loadaddr = 0x2900;
        const basicstart = 0xb2c2;
        const flen = 0x003e;
        const basicfile = "\r\0\n REM created by jsatom\r\0\x14 REM \x19commandercoder.com\r\0\x1E END\r";
        const fend = 0xc3;

        // Build the byte array for the README file
        // Format: [fname (16 bytes), loadaddr (2 bytes LE), basicstart (2 bytes LE), flen (2 bytes LE), basicfile (flen bytes), fend (1 byte)]
        const readmeBytes = new Uint8Array(16 + 2 + 2 + 2 + basicfile.length + 1);
        let offset = 0;
        // fname (16 bytes)
        for (let i = 0; i < 16; i++) {
            readmeBytes[offset++] = fname.charCodeAt(i);
        }
        // loadaddr (2 bytes, little endian)
        readmeBytes[offset++] = loadaddr & 0xff;
        readmeBytes[offset++] = (loadaddr >> 8) & 0xff;
        // basicstart (2 bytes, little endian)
        readmeBytes[offset++] = basicstart & 0xff;
        readmeBytes[offset++] = (basicstart >> 8) & 0xff;
        // flen (2 bytes, little endian)
        readmeBytes[offset++] = flen & 0xff;
        readmeBytes[offset++] = (flen >> 8) & 0xff;
        // basicfile (flen bytes)
        for (let i = 0; i < basicfile.length; i++) {
            readmeBytes[offset++] = basicfile.charCodeAt(i);
        }
        // fend (1 byte)
        readmeBytes[offset++] = fend;

        this.WFN.allfiles = [new WFNFile("/README", readmeBytes)];
    }

    /**
     * @param {Object} cpu - The CPU instance.
     */
    constructor(cpu) {
        this.cpu = cpu;
        this.gamepad = null;
        this.MMCtoAtom = STATUS_BUSY;
        this.heartbeat = 0x55;
        this.MCUStatus = MMC_MCU_BUSY;
        this.configByte = 0;
        this.byteValueLatch = 0;
        this.worker = null;
        this.seekpos = 0;
        this.WildPattern = ".*";
        this.foldersSeen = [];
        this.dfn = 0;
        this.TRISB = 0;
        this.PORTB = 0;
        this.LATB = 0;

        this.WFN = new WFN(this, cpu);
        this.reset(true);
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
        this.lastaddr = addr;
        this.at_process(addr, val, true);
    }

    // CPU is reading from 0xb400-0xb40c
    read(addr) {
        const Current = this.MMCtoAtom;
        const val = Current & 0xff;
        const reg = addr & 0x0f;
        const stat = this.MCUStatus;
        this.MCUStatus &= ~MMC_MCU_READ;
        addr = this.lastaddr;
        if (reg === STATUS_REG) {
            return stat;
        }
        this.at_process(addr, val, false);
        return Current;
    }
    /**
     * Process Atom MMC register access.
     * @param {number} addr
     * @param {number} val
     * @param {boolean} write
     */
    at_process(addr, val, write) {
        const LatchedAddress = addr & 0x0f;
        const ADDRESS_MASK = 0x07;
        this.worker = null;
        this.MCUStatus |= MMC_MCU_READ;
        if (write === false) {
            this.MCUStatus &= ~MMC_MCU_READ;
            switch (LatchedAddress) {
                case READ_DATA_REG: {
                    let data = this.WFN.getData();
                    this.WriteDataPort(data);
                    break;
                }
            }
        } else {
            switch (LatchedAddress & ADDRESS_MASK) {
                case CMD_REG: {
                    let received = val & 0xff;
                    if ((received & 0x98) === 0x10) {
                        this.WFN.filenum = (received >> 5) & 3;
                        received &= 0x9f;
                    }
                    if ((received & 0xf0) === 0x20) {
                        this.WFN.filenum = (received >> 2) & 3;
                        received &= 0xf3;
                    }
                    this.WriteDataPort(STATUS_BUSY);
                    this.MCUStatus |= MMC_MCU_BUSY;
                    if (received === CMD_DIR_OPEN) {
                        this.worker = () => this.WFN.WFN_DirectoryOpen();
                    } else if (received === CMD_DIR_READ) {
                        this.worker = () => this.WFN.WFN_DirectoryRead();
                    } else if (received === CMD_DIR_CWD) {
                        this.worker = () => this.WFN.WFN_SetCWDirectory();
                    } else if (received == CMD_DIR_MKDIR) {
                        // create directory
                        this.worker = () => this.WFN.WFN_DirectoryCreate();
                    } else if (received == CMD_DIR_RMDIR) {
                        // delete directory
                        this.worker = () => this.WFN.WFN_DirectoryDelete();
                    } else if (received == CMD_RENAME) {
                        // rename
                        this.worker = () => this.WFN.WFN_Rename();
                    } else if (received === CMD_FILE_CLOSE) {
                        this.worker = () => this.WFN.WFN_FileClose();
                    } else if (received === CMD_FILE_OPEN_READ) {
                        this.worker = () => this.WFN.WFN_FileOpenRead();
                    } else if (received === CMD_FILE_OPEN_WRITE) {
                        this.worker = () => this.WFN.WFN_FileOpenWrite();
                    } else if (received === CMD_FILE_OPEN_RAF) {
                        this.worker = () => this.WFN.WFN_FileOpenRAF();
                    } else if (received === CMD_FILE_DELETE) {
                        this.worker = () => this.WFN.WFN_FileDelete();
                    } else if (received === CMD_FILE_GETINFO) {
                        this.worker = () => this.WFN.WFN_FileGetInfo();
                    } else if (received === CMD_FILE_SEEK) {
                        this.worker = () => this.WFN.WFN_FileSeek();
                    } else if (received === CMD_INIT_READ) {
                        // console.log("CMD_INIT_READ of a 256 byte buffer using READ_DATA_REG");
                        let data = this.WFN.getData(true);
                        this.WriteDataPort(data);
                        this.lastaddr = READ_DATA_REG;
                    } else if (received === CMD_INIT_WRITE) {
                        this.WFN.clearData();
                    } else if (received === CMD_READ_BYTES) {
                        this.WFN.setTransferLength(this.byteValueLatch);
                        this.worker = () => this.WFN.WFN_FileRead();
                    } else if (received === CMD_WRITE_BYTES) {
                        this.WFN.setTransferLength(this.byteValueLatch);
                        this.worker = () => this.WFN.WFN_FileWrite();
                    } else if (received === CMD_EXEC_PACKET) {
                        this.worker = () => this.WFN.WFN_ExecuteArbitrary();
                    } else if (received === CMD_GET_FW_VER) {
                        this.WriteDataPort((VSN_MAJ << 4) | VSN_MIN);
                    } else if (received === CMD_GET_BL_VER) {
                        this.WriteDataPort(1);
                    } else if (received === CMD_GET_CFG_BYTE) {
                        // console.log(`CMD_REG:CMD_GET_CFG_BYTE -> 0x${this.configByte.toString(16)}`);
                        this.WriteDataPort(this.configByte);
                    } else if (received === CMD_SET_CFG_BYTE) {
                        this.configByte = this.byteValueLatch;
                        // console.log(`CMD_REG:CMD_SET_CFG_BYTE -> 0x${this.configByte.toString(16)}`);
                        this.WriteDataPort(STATUS_OK);
                    } else if (received === CMD_READ_AUX) {
                        this.WriteDataPort(this.LatchedAddress);
                    } else if (received === CMD_GET_HEARTBEAT) {
                        this.WriteDataPort(this.heartbeat);
                        this.heartbeat ^= 0xff;
                    } else if (received === CMD_GET_CARD_TYPE) {
                        this.WriteDataPort(0x01);
                    } else if (received === CMD_GET_PORT_DDR) {
                        this.WriteDataPort(this.TRISB);
                    } else if (received === CMD_SET_PORT_DDR) {
                        this.TRISB = this.byteValueLatch;
                        this.WriteDataPort(STATUS_OK);
                    } else if (received === CMD_READ_PORT) {
                        let JOYSTICK = 0xff;
                        const joyst = true;
                        if (joyst && this.gamepad && this.gamepad.gamepadButtons !== undefined) {
                            if (this.gamepad.gamepadButtons[15]) JOYSTICK ^= 1;
                            if (this.gamepad.gamepadButtons[14]) JOYSTICK ^= 2;
                            if (this.gamepad.gamepadButtons[13]) JOYSTICK ^= 4;
                            if (this.gamepad.gamepadButtons[12]) JOYSTICK ^= 8;
                            if (this.gamepad.gamepadButtons[0]) JOYSTICK ^= 0x10;
                            this.WriteDataPort(JOYSTICK);
                        } else {
                            this.WriteDataPort(this.PORTB);
                        }
                    } else if (received === CMD_WRITE_PORT) {
                        this.LATB = this.byteValueLatch;
                        this.WriteDataPort(STATUS_OK);
                    } else {
                        console.log(`unrecognised CMD: ${received}`);
                    }
                    break;
                }
                case WRITE_DATA_REG: {
                    const received = val & 0xff;
                    this.WFN.addData(received);
                    break;
                }
                case LATCH_REG: {
                    const received = val & 0xff;
                    // console.log(`LATCH_REG 0x${(addr & 0x0f).toString(16)} <- received 0x${received.toString(16)}`);
                    this.byteValueLatch = received;
                    this.WriteDataPort(this.byteValueLatch);
                    break;
                }
                case STATUS_REG: {
                    // does nothing
                    break;
                }
            }
            if (this.worker) {
                this.worker();
            }
        }
    }
}
