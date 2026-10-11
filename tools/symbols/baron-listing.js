/**
 * Reads a baron -vv listing of one source file (`baron -vv -log0 FILE SOURCE`): its sections, where each
 * sits in memory and in its file, the bytes of every statement, its labels and its `=` names, each with
 * the scope it was written in.
 *
 * The listing has a line for each label (`  3000  .loader`), each statement that emits bytes (its
 * address, up to eight bytes, then the statement; longer runs go on in lines of bytes alone), each
 * statement that emits none (`INCLUDE`, a macro's call), each `NAME = value [expression]`, `SECTION ...`
 * and `ENDSECTION`, and `{` and `}` for scopes, a label just before a `{` naming it. Comments don't
 * appear. Plain -v cuts a statement's bytes at eight, so it can't be read for them.
 *
 * A SECTION inside another (a "rephased" section, assembled for where it runs but stored in its
 * parent's file) emits its bytes into the parent's stream at the parent's address when the SECTION
 * starts.
 */

/** The documented 6502 instruction set: anything else is data, a macro's call or a directive. */
const Mnemonics = new Set(
    (
        "ADC AND ASL BCC BCS BEQ BIT BMI BNE BPL BRK BVC BVS CLC CLD CLI CLV CMP CPX CPY " +
        "DEC DEX DEY EOR INC INX INY JMP JSR LDA LDX LDY LSR NOP ORA PHA PHP PLA PLP ROL " +
        "ROR RTI RTS SBC SEC SED SEI STA STX STY TAX TAY TSX TXA TXS TYA"
    ).split(" "),
);

const AddressLine = /^ {2}([0-9A-F]{4}) {2}/;
const LabelLine = /^ {2}([0-9A-F]{4}) {2}\.([A-Za-z_]\w*)\s*$/;
const AssignLine = /^([A-Za-z_]\w*) = /;
const SectionLine = /^SECTION /i;
const EndSectionLine = /^ENDSECTION$/i;
const IncludeStatement = /^INCLUDE\s+"([^"]*)"/i;
const HexByte = /^[0-9A-F]{2}$/;
const BytesColumn = 8;
const SourceColumn = 36;
const AnonymousScope = "@";
const Padding = new Set(["SKIP", "SKIPTO"]);

const firstWord = (text) => text.trim().split(/\s+/, 1)[0] ?? "";

export class Statement {
    /**
     * @param {number} address - where it runs
     * @param {number[]} data
     * @param {string} text - the statement as the listing gives it
     * @param {Section | null} section
     * @param {(string | null)[]} scope - the named scopes it's in, outermost first; null for an anonymous one
     */
    constructor(address, data, text, section, scope) {
        this.address = address;
        this.data = data;
        this.text = text;
        this.section = section;
        this.scope = scope;
        const word = firstWord(text).toUpperCase();
        this.mnemonic = Mnemonics.has(word) ? word : null;
        this.code = this.mnemonic !== null;
        const space = text.search(/\s/);
        this.operand = space < 0 ? "" : text.slice(space).trim();
        this.skip = Padding.has(word);
    }
}

export class Section {
    constructor(name, header, parent) {
        this.name = name;
        this.header = header;
        this.parent = parent;
        /** The parent's address where this section's bytes are stored. */
        this.storedAt = null;
        this.org = null;
        this.end = null;
        /** @type {Statement[]} */
        this.statements = [];
        /** @type {Section[]} */
        this.children = [];
    }

    get filename() {
        return /filename="([^"]*)"/i.exec(this.header)?.[1] ?? null;
    }

    /** The exec address the SECTION line gives, or null. */
    get exec() {
        const digits = /exec=&([0-9A-Fa-f]+)/i.exec(this.header)?.[1];
        return digits === undefined ? null : parseInt(digits, 16);
    }

    /** @returns {Map<number, number>} run address to byte, for everything this section emits itself */
    memory() {
        const out = new Map();
        for (const statement of this.statements)
            statement.data.forEach((byte, i) => out.set(statement.address + i, byte));
        return out;
    }

    /** @returns {Map<number, number>} its addresses as they hold once loaded, with its children where they're stored */
    image() {
        const out = this.memory();
        for (const child of this.children)
            for (const [address, byte] of child.image()) out.set(child.storedAt + address - child.org, byte);
        return out;
    }
}

/**
 * @typedef {object} Label
 * @property {string} name - qualified with its scopes
 * @property {number} address
 * @property {Section | null} section
 * @property {(string | null)[]} scope
 * @property {number} order - its line in the listing
 */

const qualify = (scope, name) => [...scope, name].join(".");

/**
 * @param {string} text - the listing, as latin1
 * @returns {{sections: Section[], statements: Statement[], labels: Label[], internalLabels: Label[],
 *     assigns: Map<string, (string | null)[]>, includedNames: Map<string, Set<string>>}}
 *     `assigns` maps each qualified `=` name to the scope it was written in, `includedNames` each
 *     INCLUDEd file to the names the listing assigns straight after it, before any other line
 */
export function parseBaronListing(text) {
    const sections = [];
    const statements = [];
    const labels = [];
    const internalLabels = [];
    const assigns = new Map();
    const includedNames = new Map();
    const stack = [];
    const scope = [];
    const position = new Map();
    let lastLabel = null;
    let current = null;
    let include = null;

    const advance = (section, address, length) => {
        if (section.org === null) section.org = address;
        position.set(section, address + length);
    };

    const lines = text.split(/\r\n|\r|\n/);
    lines.forEach((line, number) => {
        const followsLabel = lastLabel;
        lastLabel = null;
        const assign = AssignLine.exec(line);
        if (!assign) include = null;
        const sectionStart = SectionLine.exec(line);
        if (sectionStart) {
            const name = line.slice(sectionStart[0].length).split(",")[0].trim();
            const parent = stack.at(-1) ?? null;
            const section = new Section(name, line, parent);
            if (parent) {
                section.storedAt = position.get(parent) ?? parent.org;
                parent.children.push(section);
            }
            sections.push(section);
            stack.push(section);
            current = null;
            return;
        }
        if (EndSectionLine.test(line)) {
            const section = stack.pop();
            section.end = position.get(section) ?? section.org;
            const parent = stack.at(-1);
            if (parent) advance(parent, section.storedAt, section.end - section.org);
            current = null;
            return;
        }
        if (line === "{") {
            scope.push(followsLabel ? followsLabel.name.split(".").at(-1) : null);
            current = null;
            return;
        }
        if (line === "}") {
            scope.pop();
            current = null;
            return;
        }
        if (assign) {
            if (!scope.includes(null)) assigns.set(qualify(scope, assign[1]), [...scope]);
            if (include) include.add(assign[1]);
            current = null;
            return;
        }
        const label = LabelLine.exec(line);
        if (label) {
            const address = parseInt(label[1], 16);
            const section = stack.at(-1) ?? null;
            const found = {
                name: qualify(
                    scope.map((s) => s ?? AnonymousScope),
                    label[2],
                ),
                address,
                section,
                scope: [...scope],
                order: number,
            };
            (scope.includes(null) ? internalLabels : labels).push(found);
            if (section) advance(section, address, 0);
            lastLabel = found;
            current = null;
            return;
        }
        const statementLine = AddressLine.exec(line);
        if (!statementLine) {
            current = null;
            return;
        }
        const address = parseInt(statementLine[1], 16);
        const data = line
            .slice(BytesColumn, SourceColumn)
            .split(/\s+/)
            .filter((field) => HexByte.test(field))
            .map((field) => parseInt(field, 16));
        const statementText = line.slice(SourceColumn).trim();
        const section = stack.at(-1) ?? null;
        const included = IncludeStatement.exec(statementText);
        if (included) {
            if (!includedNames.has(included[1])) includedNames.set(included[1], new Set());
            include = includedNames.get(included[1]);
        }
        if (data.length && !statementText && current && current.address + current.data.length === address) {
            current.data.push(...data);
        } else if (data.length) {
            current = new Statement(address, data, statementText, section, [...scope]);
            if (section) section.statements.push(current);
            statements.push(current);
        } else {
            current = null;
        }
        if (section) advance(section, address, data.length);
    });
    return { sections, statements, labels, internalLabels, assigns, includedNames };
}

/** The one section called `name`; throws if there's none or more than one. */
export function sectionNamed(listing, name) {
    const found = listing.sections.filter((section) => section.name === name);
    if (found.length !== 1) throw new Error(`There's no single section ${name}`);
    return found[0];
}
