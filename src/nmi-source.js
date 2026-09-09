/** One bit per device that can drive the NMI line; the CPU takes the OR of them all. */
export const NmiSource = Object.freeze({
    fdc: 0x01,
    econet: 0x02,
    tube: 0x04,
});
