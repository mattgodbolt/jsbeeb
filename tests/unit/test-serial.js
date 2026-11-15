import { describe, it, expect, beforeEach, vi } from "vitest";
import { Serial } from "../../src/serial.js";

describe("Serial", () => {
    // Create mock for the ACIA dependency
    const mockAcia = {
        setSerialReceive: vi.fn(),
        setSerialTransmit: vi.fn(),
        setMotor: vi.fn(),
        selectRs423: vi.fn(),
    };

    let serial;

    beforeEach(() => {
        // Reset mocks before each test
        vi.resetAllMocks();

        // Create a fresh Serial instance
        serial = new Serial(mockAcia);
    });

    describe("Initialization", () => {
        it("should initialize with default state", () => {
            expect(serial.reg).toBe(0);
            expect(serial.transmitRate).toBe(0);
            expect(serial.receiveRate).toBe(0);
        });

        it("should reset to default state", () => {
            // Change state
            serial.reg = 0xff;
            serial.transmitRate = 7;
            serial.receiveRate = 7;

            // Reset
            serial.reset();

            // Check state is back to default
            expect(serial.reg).toBe(0);
            expect(serial.transmitRate).toBe(0);
            expect(serial.receiveRate).toBe(0);
        });
    });

    describe("Register write operation", () => {
        it("should store value and update rates on write", () => {
            // Write value 0x2A to register (00101010)
            // - transmitRate = 010 = 2
            // - receiveRate = 101 = 5
            serial.write(0, 0x2a);

            expect(serial.reg).toBe(0x2a);
            expect(serial.transmitRate).toBe(2);
            expect(serial.receiveRate).toBe(5);
        });

        it("should mask value to 8 bits on write", () => {
            // Write value 0x1FF to register, should be masked to 0xFF
            serial.write(0, 0x1ff);

            expect(serial.reg).toBe(0xff);
        });

        it.each([
            [75, 0x7f],
            [150, 0x5b],
            [300, 0x6d],
            [1200, 0xc9],
            [2400, 0xf6],
            [4800, 0xd2],
            [9600, 0xe4],
            [19200, 0x40],
        ])("runs at %i baud when written the OS table's byte for it", (baud, value) => {
            serial.write(0, value);

            expect(mockAcia.setSerialTransmit).toHaveBeenLastCalledWith(baud);
            expect(mockAcia.setSerialReceive).toHaveBeenLastCalledWith(baud);
        });

        it("should set motor state based on bit 7", () => {
            // Test with bit 7 = 0
            serial.write(0, 0x00);
            expect(mockAcia.setMotor).toHaveBeenLastCalledWith(false);

            // Test with bit 7 = 1
            serial.write(0, 0x80);
            expect(mockAcia.setMotor).toHaveBeenLastCalledWith(true);
        });

        it("should select RS-423 based on bit 6", () => {
            // Test with bit 6 = 0
            serial.write(0, 0x00);
            expect(mockAcia.selectRs423).toHaveBeenLastCalledWith(false);

            // Test with bit 6 = 1
            serial.write(0, 0x40);
            expect(mockAcia.selectRs423).toHaveBeenLastCalledWith(true);
        });

        it("should handle complex register values", () => {
            // Write value 0xEA to register (11101010)
            // - transmitRate = 010 = 2
            // - receiveRate = 101 = 5
            // - bit 6 = 1 (select RS-423)
            // - bit 7 = 1 (motor on)
            serial.write(0, 0xea);

            expect(serial.reg).toBe(0xea);
            expect(serial.transmitRate).toBe(2);
            expect(serial.receiveRate).toBe(5);
            expect(mockAcia.setSerialReceive).toHaveBeenCalledWith(300);
            expect(mockAcia.setSerialTransmit).toHaveBeenCalledWith(4800);
            expect(mockAcia.setMotor).toHaveBeenCalledWith(true);
            expect(mockAcia.selectRs423).toHaveBeenCalledWith(true);
        });
    });

    describe("Register read operation", () => {
        it("should reset register to 0xFE on read", () => {
            // Set initial state
            serial.write(0, 0x2a);

            // Read should reset to 0xFE
            const result = serial.read();

            // Check result is 0
            expect(result).toBe(0);

            // Check register was updated
            expect(serial.reg).toBe(0xfe);
            // Check rates were updated
            expect(serial.transmitRate).toBe(6); // 0xFE & 0x07 = 6
            expect(serial.receiveRate).toBe(7); // (0xFE >>> 3) & 0x07 = 7
            // Check ACIA was updated
            expect(mockAcia.setSerialReceive).toHaveBeenLastCalledWith(75);
            expect(mockAcia.setSerialTransmit).toHaveBeenLastCalledWith(2400);
            expect(mockAcia.setMotor).toHaveBeenLastCalledWith(true);
            expect(mockAcia.selectRs423).toHaveBeenLastCalledWith(true);
        });
    });

    describe("Edge cases", () => {
        it("should ignore address in write", () => {
            // Write to different addresses should have same effect
            serial.write(0, 0x2a);
            expect(serial.reg).toBe(0x2a);

            serial.write(1, 0x3b);
            expect(serial.reg).toBe(0x3b);

            serial.write(0xff, 0x4c);
            expect(serial.reg).toBe(0x4c);
        });
    });
});
