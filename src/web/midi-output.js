import { localStore } from "./browser-storage.js";

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
        this.pendingMessageTimestamp = null;
        this.sysexMessage = null;
        this.sysexStartTimestamp = null;
        this.batch = null;
        this.interfaceEnabled = false;
        this.selectionEnabled = false;
        this.ensureNoOutputOption();
        this.select.value = localStore().getItem(StoredOutputId) ?? "";

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
        } else if (localStore().getItem(StoredOutputId)) {
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
        const selectedId = this.select.value || localStore().getItem(StoredOutputId) || "";
        const outputs = [...this.access.outputs.values()].filter((output) => output.state === "connected");
        this.select.replaceChildren(new Option(NoOutputLabel, ""));
        for (const [index, output] of outputs.entries()) {
            const name = [output.manufacturer, output.name].filter(Boolean).join(" ");
            this.select.add(new Option(name || output.id || `MIDI output ${index + 1}`, output.id));
        }
        this.updateSelectEnabled();
        const selectedOutput = outputs.find((output) => output.id === selectedId);
        this.select.value = selectedOutput?.id ?? "";
        if (selectedId && !selectedOutput) localStore().removeItem(StoredOutputId);
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
            localStore().setItem(StoredOutputId, this.output.id);
            this.warnedNoOutput = false;
            this.updateStatus();
        } else {
            localStore().removeItem(StoredOutputId);
            this.status.textContent = "No MIDI output selected.";
        }
    }

    updateStatus() {
        this.status.textContent = "";
    }

    beginBatch(cycle, startTime, cyclesPerSecond, speedy) {
        this.batch = speedy ? null : { cycle, startTime, cyclesPerSecond };
    }

    sendByte(value, cycle) {
        value &= 0xff;
        const timestamp = this.timestampForCycle(cycle);
        if (value >= 0xf8) {
            if (value !== 0xf9 && value !== 0xfd) this.sendMessage([value], timestamp);
            return;
        }
        if (this.sysexMessage) {
            if (value === 0xf7) {
                this.sysexMessage.push(value);
                this.sendMessage(this.sysexMessage, this.sysexStartTimestamp);
                this.sysexMessage = null;
                this.sysexStartTimestamp = null;
            } else if (value >= 0x80) {
                this.sysexMessage = null;
                this.sysexStartTimestamp = null;
                this.startMessage(value, timestamp);
            } else if (this.sysexMessage.length < MaxSysexBytes) {
                this.sysexMessage.push(value);
            } else {
                this.sysexMessage = null;
                this.sysexStartTimestamp = null;
                this.status.textContent = "Discarded an oversized MIDI system-exclusive message.";
            }
            return;
        }
        if (value >= 0x80) {
            this.startMessage(value, timestamp);
            return;
        }
        if (!this.pendingMessage.length) {
            if (!this.runningStatus) return;
            this.pendingMessage = [this.runningStatus];
            this.pendingMessageTimestamp = timestamp;
        }
        this.pendingMessage.push(value);
        this.finishMessageIfReady();
    }

    startMessage(status, timestamp) {
        this.pendingMessage = [];
        this.pendingMessageTimestamp = null;
        if (status === 0xf0) {
            this.runningStatus = 0;
            this.sysexMessage = [status];
            this.sysexStartTimestamp = timestamp;
            return;
        }
        if (status < 0xf0) this.runningStatus = status;
        else this.runningStatus = 0;
        const length = messageLength(status);
        if (!length) return;
        this.pendingMessage = [status];
        this.pendingMessageTimestamp = timestamp;
        this.finishMessageIfReady();
    }

    finishMessageIfReady() {
        const length = messageLength(this.pendingMessage[0]);
        if (this.pendingMessage.length !== length) return;
        this.sendMessage(this.pendingMessage, this.pendingMessageTimestamp);
        this.pendingMessage = [];
        this.pendingMessageTimestamp = null;
    }

    timestampForCycle(cycle) {
        if (!this.batch || cycle === null || cycle === undefined) return null;
        return this.batch.startTime + ((cycle - this.batch.cycle) * 1000) / this.batch.cyclesPerSecond;
    }

    sendMessage(message, timestamp) {
        if (!this.interfaceEnabled || !this.output || this.output.state !== "connected") {
            if (!this.warnedNoOutput) this.status.textContent = "Connect and choose a MIDI output to send MIDI.";
            this.warnedNoOutput = true;
            return;
        }
        try {
            if (timestamp === null) this.output.send(message);
            else this.output.send(message, timestamp);
            this.updateStatus();
        } catch (error) {
            console.error("Unable to send MIDI message", error);
            this.status.textContent = `Could not send MIDI: ${error.message}`;
        }
    }
}
