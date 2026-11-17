/** Just enough of a machine for the VDFS modules: 64K of memory they can look at and change. */
export function fakeCpu({ hasTube = false } = {}) {
    const memory = new Uint8Array(0x10000);
    return {
        memory,
        hasTube,
        peekmem: (address) => memory[address & 0xffff],
        writemem: (address, value) => {
            memory[address & 0xffff] = value;
        },
    };
}

export function poke(cpu, address, bytes) {
    for (const [index, byte] of [...bytes].entries())
        cpu.memory[address + index] = typeof byte === "string" ? byte.charCodeAt(0) : byte;
}

/** Puts a string, with its return, in memory and gives its address. */
export function putString(cpu, address, string) {
    poke(cpu, address, [...string, 0x0d]);
    return address;
}

export function putLong(cpu, address, value) {
    for (let index = 0; index < 4; index++) cpu.memory[address + index] = (value >>> (8 * index)) & 0xff;
}

export function getLong(cpu, address) {
    return (
        (cpu.memory[address] |
            (cpu.memory[address + 1] << 8) |
            (cpu.memory[address + 2] << 16) |
            (cpu.memory[address + 3] << 24)) >>>
        0
    );
}
