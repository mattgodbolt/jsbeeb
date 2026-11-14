const StoredOutputId = "midiOutputId";
const NoOutputLabel = "No MIDI Interface";
const MaxSysexBytes = 1024 * 1024;
// eslint-disable-next-line compat/compat
const hasWebMidi = () => typeof navigator.requestMIDIAccess === "function";

const messageLength = (status) => {
    if (status < 0xf0) return (status & 0xe0) === 0xc0 ? 2 : 3;
    switch (status) {
        case 0xf1:
        case 0xf3:
            return 2;
        case 0xf2:
            return 3;
        case 0xf6:
            return 1;
        default:
            return 0;
    }
};

export class MidiOutput {
    constructor({ select, status }) {
        this.select = select;
        this.status = status;
        this.access = null;
        this.output = null;
        this.warnedNoOutput = false;
        this.runningStatus = 0;
        this.pendingMessage = [];
        this.sysexMessage = null;
        this.sentMessages = 0;
        this.sentBytes = 0;
        this.interfaceEnabled = false;
        this.selectionEnabled = false;
        this.ensureNoOutputOption();
        this.select.value = window.localStorage.getItem(StoredOutputId) ?? "";

        this.select.addEventListener("focus", () => this.connectWithStatus());
        this.select.addEventListener("change", () => this.selectOutput());
        this.setInterfaceEnabled(false);
    }

    ensureNoOutputOption() {
        const noOutput = [...this.select.options].find((option) => option.value === "");
        if (noOutput) noOutput.textContent ||= NoOutputLabel;
        else this.select.prepend(new Option(NoOutputLabel, ""));
    }

    setInterfaceEnabled(enabled) {
        this.interfaceEnabled = enabled;
        this.updateSelectionState();
    }

    setSelectionEnabled(enabled) {
        this.selectionEnabled = enabled;
        this.updateSelectionState();
    }

    updateSelectionState() {
        this.updateSelectEnabled();
        if (!this.selectionEnabled) {
            this.status.textContent = "Enable the 6850 MIDI interface in Peripherals and restart the emulator.";
        } else if (!hasWebMidi()) {
            this.status.textContent = "Web MIDI is not available in this runtime.";
        } else if (this.output) {
            this.updateStatus();
        } else if (this.access) {
            this.updateOutputs();
        } else if (window.localStorage.getItem(StoredOutputId)) {
            this.connectWithStatus();
        } else {
            this.status.textContent = "Focus the dropdown to connect to MIDI devices.";
        }
    }

    updateSelectEnabled() {
        this.select.disabled = !this.selectionEnabled || !hasWebMidi();
    }

    connectWithStatus() {
        this.connect().catch((error) => {
            console.error("Unable to connect to MIDI outputs", error);
            this.status.textContent = `Could not connect to MIDI outputs: ${error.message}`;
        });
    }

    async connect() {
        if (!this.selectionEnabled) return;
        if (!hasWebMidi()) throw new Error("Web MIDI is not available in this runtime");
        if (!this.access) {
            if (!this.connecting) {
                this.status.textContent = "Connecting to MIDI devices...";
                this.connecting = navigator
                    .requestMIDIAccess({ sysex: true })
                    .then((access) => {
                        this.access = access;
                        this.access.addEventListener("statechange", () => this.updateOutputs());
                    })
                    .finally(() => {
                        this.connecting = null;
                    });
            }
            await this.connecting;
        }
        this.updateOutputs();
    }

    updateOutputs() {
        const selectedId = this.select.value || window.localStorage.getItem(StoredOutputId) || "";
        const outputs = [...this.access.outputs.values()].filter((output) => output.state === "connected");
        this.select.replaceChildren(new Option(NoOutputLabel, ""));
        for (const [index, output] of outputs.entries()) {
            const name = [output.manufacturer, output.name].filter(Boolean).join(" ");
            this.select.add(new Option(name || output.id || `MIDI output ${index + 1}`, output.id));
        }
        this.updateSelectEnabled();
        const selectedOutput = outputs.find((output) => output.id === selectedId);
        this.select.value = selectedOutput?.id ?? "";
        if (selectedId && !selectedOutput) window.localStorage.removeItem(StoredOutputId);
        this.output = this.access.outputs.get(this.select.value) ?? null;
        if (!this.selectionEnabled) {
            this.status.textContent = "Enable the 6850 MIDI interface in Peripherals and restart the emulator.";
        } else if (this.output) {
            this.updateStatus();
        } else {
            this.status.textContent = outputs.length ? "No MIDI output selected." : "No MIDI outputs are available.";
        }
    }

    selectOutput() {
        if (!this.selectionEnabled) return;
        this.output = this.access?.outputs.get(this.select.value) ?? null;
        if (this.output) {
            window.localStorage.setItem(StoredOutputId, this.output.id);
            this.warnedNoOutput = false;
            this.updateStatus();
        } else {
            window.localStorage.removeItem(StoredOutputId);
            this.status.textContent = "No MIDI output selected.";
        }
    }

    updateStatus() {
        this.status.textContent = `MIDI output: ${this.output.name || this.output.id} (${this.sentMessages} messages, ${this.sentBytes} bytes submitted)`;
    }

    sendByte(value) {
        value &= 0xff;
        if (value >= 0xf8) {
            if (value !== 0xf9 && value !== 0xfd) this.sendMessage([value]);
            return;
        }
        if (this.sysexMessage) {
            if (value === 0xf7) {
                this.sysexMessage.push(value);
                this.sendMessage(this.sysexMessage);
                this.sysexMessage = null;
            } else if (value >= 0x80) {
                this.sysexMessage = null;
                this.startMessage(value);
            } else if (this.sysexMessage.length < MaxSysexBytes) {
                this.sysexMessage.push(value);
            } else {
                this.sysexMessage = null;
                this.status.textContent = "Discarded an oversized MIDI system-exclusive message.";
            }
            return;
        }
        if (value >= 0x80) {
            this.startMessage(value);
            return;
        }
        if (!this.pendingMessage.length) {
            if (!this.runningStatus) return;
            this.pendingMessage = [this.runningStatus];
        }
        this.pendingMessage.push(value);
        this.finishMessageIfReady();
    }

    startMessage(status) {
        this.pendingMessage = [];
        if (status === 0xf0) {
            this.runningStatus = 0;
            this.sysexMessage = [status];
            return;
        }
        if (status < 0xf0) this.runningStatus = status;
        else this.runningStatus = 0;
        const length = messageLength(status);
        if (!length) return;
        this.pendingMessage = [status];
        this.finishMessageIfReady();
    }

    finishMessageIfReady() {
        const length = messageLength(this.pendingMessage[0]);
        if (this.pendingMessage.length !== length) return;
        this.sendMessage(this.pendingMessage);
        this.pendingMessage = [];
    }

    sendMessage(message) {
        if (!this.interfaceEnabled || !this.output || this.output.state !== "connected") {
            if (!this.warnedNoOutput) this.status.textContent = "Connect and choose a MIDI output to send MIDI.";
            this.warnedNoOutput = true;
            return;
        }
        try {
            this.output.send(message);
            this.sentMessages++;
            this.sentBytes += message.length;
            this.updateStatus();
        } catch (error) {
            console.error("Unable to send MIDI message", error);
            this.status.textContent = `Could not send MIDI: ${error.message}`;
        }
    }
}
