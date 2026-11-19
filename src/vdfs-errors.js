/** An error the host raises on the 6502 as the OS would: BRK, the number, then the text. */
export class VdfsError extends Error {
    constructor(number, text) {
        super(text);
        this.number = number;
    }
}

/** Text for the BBC from the host, with anything it would act on (a VDU code, a byte over 126) shown as a question mark. */
export const printable = (text) => text.replace(/[^\x20-\x7e]/g, "?");

export const Errors = Object.freeze({
    badName: () => new VdfsError(0xcc, "Bad name"),
    notFound: () => new VdfsError(0xd6, "Not found"),
    locked: () => new VdfsError(0xc3, "Locked"),
    exists: () => new VdfsError(0xc4, "Already exists"),
    notEmpty: () => new VdfsError(0xb4, "Dir not empty"),
    isDirectory: () => new VdfsError(0xc7, "Is a directory"),
    notDirectory: () => new VdfsError(0xbe, "Not a directory"),
    tooManyOpen: () => new VdfsError(0xc0, "Too many open files"),
    notOpen: () => new VdfsError(0xde, "Channel"),
    accessViolation: () => new VdfsError(0xbd, "Access violation"),
    fileTooBig: () => new VdfsError(0xc6, "File too big"),
    noAddresses: () => new VdfsError(0xcd, "No load address (*SETINFO name load exec, or *LOAD name address)"),
    badCommand: () => new VdfsError(0xfe, "Bad command"),
    badAddress: () => new VdfsError(0x93, "Bad address"),
    unsupported: (what) => new VdfsError(0x94, `${what} is not supported`),
    eof: () => new VdfsError(0xdf, "EOF"),
    discFault: (reason) => new VdfsError(0xc8, `Disc fault: ${printable(reason)}`),
    discChanged: () => new VdfsError(0xc9, "Disc changed"),
});
