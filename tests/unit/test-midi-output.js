// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MidiOutput } from "../../src/web/midi-output.js";

describe("MidiOutput", () => {
    let access;
    let output;
    let midiOutput;
    let requestMIDIAccess;

    beforeEach(() => {
        document.body.innerHTML = `
            <select id="output"></select>
            <div id="status"></div>
        `;
        output = { id: "sc-88", name: "SC-88", state: "connected", send: vi.fn() };
        access = new EventTarget();
        access.outputs = new Map([[output.id, output]]);
        requestMIDIAccess = vi.fn().mockResolvedValue(access);
        Object.defineProperty(navigator, "requestMIDIAccess", {
            configurable: true,
            value: requestMIDIAccess,
        });
        midiOutput = new MidiOutput({
            select: document.getElementById("output"),
            status: document.getElementById("status"),
        });
    });

    afterEach(() => {
        window.localStorage.removeItem("midiOutputId");
        delete navigator.requestMIDIAccess;
    });

    it("always keeps a nonempty no-output label in the dropdown", () => {
        const select = document.getElementById("output");

        expect(select.options).toHaveLength(1);
        expect(select.options[0].textContent).toBe("No MIDI Interface");
        expect(select.value).toBe("");
    });

    it("requests MIDI access from the output selector and sends complete messages", async () => {
        midiOutput.setSelectionEnabled(true);
        midiOutput.setInterfaceEnabled(true);
        const select = document.getElementById("output");
        select.focus();
        await vi.waitFor(() => expect(select.querySelector('option[value="sc-88"]')).not.toBeNull());
        expect([...select.options].every((option) => option.textContent.trim())).toBe(true);
        expect(requestMIDIAccess).toHaveBeenCalledWith({ sysex: true });

        select.value = output.id;
        select.dispatchEvent(new Event("change"));
        for (const byte of [0x90, 60, 100, 61, 110]) midiOutput.sendByte(byte);

        expect(output.send.mock.calls).toEqual([[[0x90, 60, 100]], [[0x90, 61, 110]]]);
        expect(document.getElementById("status").textContent).toBe(
            "MIDI output: SC-88 (2 messages, 6 bytes submitted)",
        );
    });

    it("reselects the saved output automatically when MIDI access is established", async () => {
        window.localStorage.setItem("midiOutputId", output.id);
        midiOutput.setSelectionEnabled(true);
        midiOutput.setInterfaceEnabled(true);

        const select = document.getElementById("output");
        await vi.waitFor(() => expect(select.value).toBe(output.id));

        expect(requestMIDIAccess).toHaveBeenCalledWith({ sysex: true });
        expect(window.localStorage.getItem("midiOutputId")).toBe(output.id);
        midiOutput.sendByte(0xf6);
        expect(output.send).toHaveBeenCalledWith([0xf6]);
    });

    it("clears a saved output that is no longer connected", async () => {
        window.localStorage.setItem("midiOutputId", "unavailable-output");
        access.outputs.clear();
        midiOutput.setSelectionEnabled(true);
        midiOutput.setInterfaceEnabled(true);

        const select = document.getElementById("output");
        await vi.waitFor(() => expect(requestMIDIAccess).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(window.localStorage.getItem("midiOutputId")).toBeNull());

        expect(select.value).toBe("");
        expect(window.localStorage.getItem("midiOutputId")).toBeNull();
        expect(document.getElementById("status").textContent).toBe("No MIDI outputs are available.");
    });

    it("does not offer or restore a disconnected output", async () => {
        output.state = "disconnected";
        window.localStorage.setItem("midiOutputId", output.id);
        midiOutput.setSelectionEnabled(true);
        midiOutput.setInterfaceEnabled(true);

        const select = document.getElementById("output");
        await vi.waitFor(() => expect(requestMIDIAccess).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(window.localStorage.getItem("midiOutputId")).toBeNull());

        expect(select.value).toBe("");
        expect(window.localStorage.getItem("midiOutputId")).toBeNull();
    });

    it("does not count messages rejected by the output", async () => {
        output.send.mockImplementation(() => {
            throw new Error("device unavailable");
        });
        midiOutput.setSelectionEnabled(true);
        midiOutput.setInterfaceEnabled(true);
        const select = document.getElementById("output");
        select.focus();
        await vi.waitFor(() => expect(select.querySelector('option[value="sc-88"]')).not.toBeNull());
        select.value = output.id;
        select.dispatchEvent(new Event("change"));

        for (const byte of [0x90, 60, 100]) midiOutput.sendByte(byte);

        expect(document.getElementById("status").textContent).toBe("Could not send MIDI: device unavailable");
    });

    it("buffers system-exclusive data through its end marker", async () => {
        midiOutput.setSelectionEnabled(true);
        midiOutput.setInterfaceEnabled(true);
        const select = document.getElementById("output");
        select.focus();
        await vi.waitFor(() => expect(select.querySelector('option[value="sc-88"]')).not.toBeNull());
        expect(requestMIDIAccess).toHaveBeenCalledOnce();

        select.value = output.id;
        select.dispatchEvent(new Event("change"));
        for (const byte of [0xf0, 0x41, 0x10, 0xf8, 0x42, 0xf7]) midiOutput.sendByte(byte);

        expect(output.send.mock.calls).toEqual([[[0xf8]], [[0xf0, 0x41, 0x10, 0x42, 0xf7]]]);
    });

    it("disables host output selection until the emulated interface is fitted", async () => {
        const select = document.getElementById("output");

        expect(select.disabled).toBe(true);
        expect(document.getElementById("status").textContent).toBe(
            "Enable the 6850 MIDI interface in Peripherals and restart the emulator.",
        );

        await midiOutput.connect();
        expect(requestMIDIAccess).not.toHaveBeenCalled();

        midiOutput.setInterfaceEnabled(true);
        midiOutput.setSelectionEnabled(true);
        expect(select.disabled).toBe(false);
        select.focus();
        await vi.waitFor(() => expect(requestMIDIAccess).toHaveBeenCalledOnce());
    });

    it("keeps the host output selector disabled when the fitting is unchecked", () => {
        midiOutput.setSelectionEnabled(true);
        midiOutput.setInterfaceEnabled(true);
        expect(document.getElementById("output").disabled).toBe(false);

        midiOutput.setSelectionEnabled(false);
        expect(document.getElementById("output").disabled).toBe(true);

        midiOutput.setSelectionEnabled(true);
        expect(document.getElementById("output").disabled).toBe(false);
    });

    it("enables output selection when the MIDI fitting is checked before restart", async () => {
        midiOutput.setInterfaceEnabled(false);
        midiOutput.setSelectionEnabled(true);

        const select = document.getElementById("output");
        expect(select.disabled).toBe(false);
        select.focus();
        await vi.waitFor(() => expect(select.querySelector('option[value="sc-88"]')).not.toBeNull());

        select.value = output.id;
        select.dispatchEvent(new Event("change"));
        midiOutput.sendByte(0xf6);

        expect(window.localStorage.getItem("midiOutputId")).toBe(output.id);
        expect(output.send).not.toHaveBeenCalled();
    });
});
