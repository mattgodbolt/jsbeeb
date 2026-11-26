import { CarryOut, Op, Port } from "../../src/vdfs-protocol.js";

export const errorOf = (result) => result.ops.find((op) => op.op === "error");

export const printed = (result) =>
    result.ops
        .filter((op) => op.op === "print")
        .map((op) => op.text)
        .join("");

/**
 * Reads a whole response from `host` as the ROM does: the ops up to Done, then X, Y, the carry and, last, A. `p` is the
 * carry, the only flag a response has.
 */
export function readResponse(host, registersIn) {
    const readByte = () => host.read(Port.a);
    const readText = () => {
        let result = "";
        for (let byte = readByte(); byte !== 0; byte = readByte()) result += String.fromCharCode(byte);
        return result;
    };
    const ops = [];
    for (let op = readByte(); op !== Op.done; op = readByte()) {
        if (op === Op.print) ops.push({ op: "print", text: readText() });
        else if (op === Op.claim) ops.push({ op: "claim" });
        else if (op === Op.exec) {
            const high = readByte();
            ops.push({ op: "exec", address: (((high << 8) | readByte()) + 1) & 0xffff });
            return { ops, ...registersIn };
        } else if (op === Op.error) {
            const number = readByte();
            ops.push({ op: "error", number, text: readText() });
            return { ops, ...registersIn };
        } else throw new Error(`unknown op ${op}`);
    }
    const [x, y] = [host.read(Port.x), host.read(Port.y)];
    const p = host.read(Port.go) & CarryOut ? 1 : 0;
    return { ops, a: readByte(), x, y, p };
}
