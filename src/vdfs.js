"use strict";

/**
 * VDFS (Virtual Disc Filing System) support for jsbeeb.
 *
 * Provides the ability to load a host directory of BBC Micro files and present
 * them as a standard DFS SSD disc image inside the emulator — without needing a
 * pre-built disc image file.
 *
 * Supports:
 *  - Building a DFS SSD disc image from an array of file objects
 *  - Parsing BBC .inf sidecar files for load/exec addresses and directory prefix
 *  - Converting host filenames to valid BBC DFS filenames
 *  - Reading a directory via the File System Access API (showDirectoryPicker)
 *    or a <input type="file" webkitdirectory> FileList
 */

// DFS disc layout constants
const SectorSize = 256;
const SectorsPerTrack = 10;
const TotalTracks = 80;
/** Number of sectors reserved for the DFS catalogue (sectors 0 and 1) */
const CatalogSectors = 2;
/** Maximum number of files in a DFS catalogue */
const MaxFiles = 31;
/** Total sectors on a standard single-sided 80-track DFS disc */
const TotalSectors = TotalTracks * SectorsPerTrack; // 800
/** Total byte size of an SSD disc image */
const SsdByteSize = TotalSectors * SectorSize; // 204 800

/**
 * Parse a BBC .inf sidecar file and return metadata for the associated file.
 *
 * The .inf format (used by b-em, BeebEm and others) is a single text line:
 *   D.FILENAME LOADADDR EXECADDR [LENGTH] [ATTRS]
 * where addresses are 32-bit hex values (e.g. FFFF1900) and directory prefix
 * is a single character followed by a dot (e.g. "$.FILENAME").
 *
 * @param {string} content - Raw text content of the .inf file
 * @returns {{ dir: string, name: string, loadAddr: number, execAddr: number } | null}
 */
export function parseInfFile(content) {
    const line = content.trim().split(/\r?\n/)[0];
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) return null;

    const fullName = parts[0];
    let dir = "$";
    let name = fullName;

    // Detect "D.FILENAME" prefix (directory char + dot + name)
    if (fullName.length >= 3 && fullName[1] === ".") {
        dir = fullName[0];
        name = fullName.substring(2);
    }

    const loadAddr = parseInt(parts[1], 16) || 0;
    const execAddr = parseInt(parts[2], 16) || 0;

    return {
        dir: dir.toUpperCase(),
        name: name.toUpperCase(),
        loadAddr,
        execAddr,
    };
}

/**
 * Convert a host filename to a valid BBC DFS filename.
 *
 * BBC DFS rules: max 7 characters, no dots, alphanumeric and a limited set of
 * special characters.  Invalid characters are replaced with underscore and the
 * result is uppercased.
 *
 * @param {string} filename - Host filename (may include a file extension)
 * @returns {string} Up to 7-character uppercase BBC-compatible filename
 */
export function hostToBbcFilename(filename) {
    // Strip the last extension (e.g. ".bas" → keep the rest)
    const noExt = filename.replace(/\.[^.]*$/, "");
    // Replace characters not valid in BBC filenames with underscore
    const cleaned = noExt.replace(/[^A-Za-z0-9!#%&@^_`{}~+-]+/g, "_");
    return cleaned.substring(0, 7).toUpperCase() || "FILE";
}

/**
 * Build a DFS SSD disc image (204 800 bytes) from an array of file objects.
 *
 * Files are placed contiguously starting at sector 2 (sectors 0–1 are the
 * catalogue).  Up to {@link MaxFiles} (31) files are supported per the DFS
 * spec; excess entries are silently dropped.
 *
 * @param {Array<{
 *   name: string,
 *   dir?: string,
 *   loadAddr?: number,   - 18-bit load address (low 16 bits most significant; stored little-endian). Default 0xFFFF.
 *   execAddr?: number,   - 18-bit exec address. Default 0xFFFF.
 *   data: Uint8Array
 * }>} files - Files to include on the disc
 * @param {string} [discTitle] - Disc title (max 8 chars, default "FILES")
 * @returns {Uint8Array} SSD disc image data
 */
export function buildSsd(files, discTitle = "FILES") {
    const fileList = files.slice(0, MaxFiles);
    const ssdData = new Uint8Array(SsdByteSize);

    // --- Sector 0: disc title + per-file name entries ---
    const titlePadded = discTitle.toUpperCase().padEnd(8, " ").substring(0, 8);
    for (let i = 0; i < 8; i++) {
        ssdData[i] = titlePadded.charCodeAt(i);
    }

    // --- Sector 1 header (bytes 256–263) ---
    // Bytes 0–3: disc title chars 9–12 (leave as zero — standard 8-char title)
    // Byte  4:   boot option (bits 3–0) | sequence number (bits 7–4) → 0
    // Byte  5:   top 2 bits of total-sector count  (800 = 0x320, bits 9–8 = 3)
    // Byte  6:   number of catalogue entries × 8
    // Byte  7:   low 8 bits of total-sector count  (800 & 0xFF = 0x20)
    const S1 = SectorSize;
    ssdData[S1 + 4] = 0x00;
    ssdData[S1 + 5] = (TotalSectors >> 8) & 0x03;
    ssdData[S1 + 6] = fileList.length * 8;
    ssdData[S1 + 7] = TotalSectors & 0xff;

    // Place files starting at sector 2, packing them contiguously
    let currentSector = CatalogSectors;

    for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const name = ((file.name || "FILE") + "       ").substring(0, 7).toUpperCase();
        const dir = (file.dir || "$").toUpperCase();
        const loadAddr = file.loadAddr !== undefined ? file.loadAddr : 0xffff;
        const execAddr = file.execAddr !== undefined ? file.execAddr : 0xffff;
        const data = file.data || new Uint8Array(0);
        const fileLen = data.length;
        const startSector = currentSector;

        // Sector 0 entry (8 bytes): filename (7) + directory char
        const s0Off = 8 + i * 8;
        for (let j = 0; j < 7; j++) {
            ssdData[s0Off + j] = name.charCodeAt(j);
        }
        // Bit 7 of the directory byte = lock flag (0 = unlocked)
        ssdData[s0Off + 7] = dir.charCodeAt(0) & 0x7f;

        // Sector 1 entry (8 bytes): load addr, exec addr, length, sector info
        const s1Off = S1 + 8 + i * 8;
        ssdData[s1Off + 0] = loadAddr & 0xff;
        ssdData[s1Off + 1] = (loadAddr >> 8) & 0xff;
        ssdData[s1Off + 2] = execAddr & 0xff;
        ssdData[s1Off + 3] = (execAddr >> 8) & 0xff;
        ssdData[s1Off + 4] = fileLen & 0xff;
        ssdData[s1Off + 5] = (fileLen >> 8) & 0xff;
        // Byte 6: packed high bits
        //   bits 7–6: start sector bits [9:8]
        //   bits 5–4: file length bits [17:16]
        //   bits 3–2: exec address bits [17:16]
        //   bits 1–0: load address bits [17:16]
        ssdData[s1Off + 6] =
            (((startSector >> 8) & 0x03) << 6) |
            (((fileLen >> 16) & 0x03) << 4) |
            (((execAddr >> 16) & 0x03) << 2) |
            ((loadAddr >> 16) & 0x03);
        ssdData[s1Off + 7] = startSector & 0xff;

        // Copy file data into the appropriate position in the image
        const fileOffset = startSector * SectorSize;
        const bytesToCopy = Math.min(fileLen, ssdData.length - fileOffset);
        if (bytesToCopy > 0) {
            ssdData.set(data.subarray(0, bytesToCopy), fileOffset);
        }

        currentSector += Math.ceil(fileLen / SectorSize);
    }

    return ssdData;
}

/**
 * Determine whether the browser supports the File System Access API
 * (specifically `showDirectoryPicker`).
 *
 * @returns {boolean}
 */
export function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/**
 * Open a native directory picker (File System Access API) and return all
 * non-hidden files inside as an array of {@link File} objects, together with
 * the directory name (used as the disc title).
 *
 * @returns {Promise<{ files: File[], dirName: string } | null>}
 *   Resolves to `null` if the user cancels the picker.
 */
export async function pickDirectory() {
    let dirHandle;
    try {
        dirHandle = await window.showDirectoryPicker({ mode: "read" });
    } catch {
        // User cancelled or permission denied
        return null;
    }

    const files = [];
    for await (const [, handle] of dirHandle.entries()) {
        if (handle.kind === "file") {
            files.push(await handle.getFile());
        }
    }

    return { files, dirName: dirHandle.name };
}

/**
 * Process a collection of {@link File} objects (from a directory picker, a
 * `webkitdirectory` `<input>`, or an Electron IPC message converted to File
 * objects) and produce an array of BBC file entries ready for {@link buildSsd}.
 *
 * Processing rules:
 *  1. Files whose name ends in `.inf` are treated as BBC sidecar metadata.
 *  2. Hidden files (name starts with `.`) are skipped.
 *  3. Each non-inf file is matched against a same-named `.inf` sidecar for
 *     load address, exec address, and directory prefix.
 *  4. If no `.inf` exists the host filename is converted to a BBC name and
 *     default addresses (0xFFFF) are used.
 *  5. Duplicate BBC names are disambiguated by appending a numeric suffix.
 *
 * @param {File[]} fileObjects
 * @returns {Promise<Array<{ name: string, dir: string, loadAddr: number, execAddr: number, data: Uint8Array }>>}
 */
export async function processHostFiles(fileObjects) {
    const infMap = {};
    const regularFiles = [];

    for (const file of fileObjects) {
        const lowerName = file.name.toLowerCase();
        if (lowerName.endsWith(".inf")) {
            const text = await file.text();
            const baseName = file.name.slice(0, -4).toLowerCase();
            infMap[baseName] = parseInfFile(text);
        } else if (!file.name.startsWith(".")) {
            regularFiles.push(file);
        }
    }

    const usedNames = new Set();
    const result = [];

    for (const file of regularFiles) {
        const inf = infMap[file.name.toLowerCase()];
        let bbcName = inf ? inf.name : hostToBbcFilename(file.name);
        const dir = inf ? inf.dir : "$";
        const loadAddr = inf ? inf.loadAddr : 0xffff;
        const execAddr = inf ? inf.execAddr : 0xffff;

        // Ensure the name is unique within the catalogue
        if (usedNames.has(bbcName)) {
            let counter = 1;
            let candidate;
            do {
                const suffix = String(counter++);
                candidate = bbcName.substring(0, 7 - suffix.length) + suffix;
            } while (usedNames.has(candidate));
            bbcName = candidate;
        }
        usedNames.add(bbcName);

        const arrayBuffer = await file.arrayBuffer();
        result.push({
            name: bbcName,
            dir,
            loadAddr,
            execAddr,
            data: new Uint8Array(arrayBuffer),
        });
    }

    return result;
}

/**
 * Derive a disc title from a set of File objects.
 *
 * For files from a `webkitdirectory` input the browser preserves the relative
 * path (e.g. "MyGames/ELITE"), so the folder name can be extracted from the
 * first file's path.  Otherwise an empty string is returned.
 *
 * @param {File[]} files
 * @returns {string} Up to 8-character disc title (uppercase), or "" if unknown
 */
export function discTitleFromFiles(files) {
    if (!files.length) return "";
    // webkitRelativePath is "folder/filename" — take the folder part
    const rel = files[0].webkitRelativePath || "";
    const folder = rel.split("/")[0];
    if (!folder) return "";
    return folder.toUpperCase().substring(0, 8);
}
