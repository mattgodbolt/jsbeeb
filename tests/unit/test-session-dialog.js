// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modals } from "../../src/web/modals.js";
import { SessionDialog } from "../../src/web/session-dialog.js";
import { domFromIndexHtml, sentEvents, teardownDom } from "./helpers.js";

describe("SessionDialog", () => {
    let host;
    let join;
    let session;

    beforeEach(() => {
        domFromIndexHtml("session-open", "session-dialog");
        session = { panel: { open: vi.fn() } };
        host = vi.fn(async () => session);
        join = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        teardownDom();
    });

    const dialog = () => document.getElementById("session-dialog");
    const find = (selector) => dialog().querySelector(selector);
    const shown = () => {
        const show = vi.fn();
        dialog().addEventListener("show.bs.modal", show);
        return show;
    };
    // The dialog takes the session once the promise host returned has settled, a turn after it.
    const hosted = async () => {
        await vi.waitFor(() => expect(host).toHaveBeenCalled());
        await host.mock.results[0].value;
        await Promise.resolve();
    };
    const openIt = () => document.getElementById("session-open").click();
    const submitJoin = (text) => {
        find(".session-room").value = text;
        find(".session-join-form").requestSubmit();
    };

    it("opens the session's pane instead while there is one", () => {
        new SessionDialog({ session, refusal: null, host, join });
        const show = shown();
        openIt();
        expect(session.panel.open).toHaveBeenCalled();
        expect(show).not.toHaveBeenCalled();
    });

    const modalEvent = (name) => new Promise((resolve) => dialog().addEventListener(name, resolve, { once: true }));
    const openDialog = async () => {
        const opened = modalEvent("shown.bs.modal");
        openIt();
        await opened;
    };
    const startHosting = async (detail = 1) => {
        const gone = modalEvent("hidden.bs.modal");
        find(".session-host").dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
        await gone;
    };

    it("hosts as the name given once the dialog has gone, and opens the pane next time", async () => {
        new SessionDialog({ session: null, refusal: null, host, join });
        await openDialog();
        find(".session-name").value = "matt";
        const gone = startHosting();
        expect(host).not.toHaveBeenCalled();
        await gone;
        await hosted();
        expect(host).toHaveBeenCalledWith("matt");
        openIt();
        expect(session.panel.open).toHaveBeenCalled();
    });

    it("notes hosting and joining as the shared session's", async () => {
        const sent = sentEvents();
        new SessionDialog({ session: null, refusal: null, host, join });
        await openDialog();
        submitJoin("not a room ?");
        submitJoin("some-room");
        await startHosting();
        await hosted();
        expect(sent("feature_used").filter(({ action }) => action !== "open")).toEqual([
            { feature: "shared_session", action: "join" },
            { feature: "shared_session", action: "host" },
        ]);
    });

    it("hosts once the page has let go of the machine it held for the dialog", async () => {
        domFromIndexHtml("error-dialog", "are-you-sure");
        const letGo = vi.fn();
        new Modals({ loop: { hold: () => letGo } });
        let heldWhenHosting;
        host.mockImplementation(async () => {
            heldWhenHosting = letGo.mock.calls.length === 0;
            return session;
        });
        new SessionDialog({ session: null, refusal: null, host, join });
        await openDialog();
        await startHosting();
        await hosted();
        expect(heldWhenHosting).toBe(false);
    });

    it("hosts once however often Start hosting is pressed", async () => {
        new SessionDialog({ session: null, refusal: null, host, join });
        await openDialog();
        const gone = startHosting();
        find(".session-host").click();
        find(".session-host").click();
        await gone;
        await hosted();
        expect(host).toHaveBeenCalledOnce();
    });

    describe("while hosting is under way", () => {
        let finish;

        beforeEach(() => {
            host.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
        });

        it("opens nothing, then the pane once it has hosted", async () => {
            new SessionDialog({ session: null, refusal: null, host, join });
            await openDialog();
            await startHosting();
            await vi.waitFor(() => expect(host).toHaveBeenCalled());
            const show = shown();
            openIt();
            expect(show).not.toHaveBeenCalled();
            finish(session);
            await hosted();
            openIt();
            expect(show).not.toHaveBeenCalled();
            expect(session.panel.open).toHaveBeenCalled();
            expect(find(".session-host").disabled).toBe(true);
        });

        it("opens the dialog again, ready to host, once it has come to nothing", async () => {
            new SessionDialog({ session: null, refusal: null, host, join });
            await openDialog();
            await startHosting();
            await vi.waitFor(() => expect(host).toHaveBeenCalled());
            finish(null);
            await hosted();
            expect(find(".session-host").disabled).toBe(false);
            const show = shown();
            openIt();
            expect(show).toHaveBeenCalled();
        });
    });

    it("ignores Start hosting pressed while the dialog is still appearing", async () => {
        new SessionDialog({ session: null, refusal: null, host, join });
        const opened = modalEvent("shown.bs.modal");
        openIt();
        find(".session-host").click();
        await opened;
        const gone = modalEvent("hidden.bs.modal");
        find(".btn-close").click();
        await gone;
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(host).not.toHaveBeenCalled();
        expect(find(".session-host").disabled).toBe(false);
    });

    describe("an Enter held on Start hosting", () => {
        const enter = (type, repeat = false) =>
            document.dispatchEvent(new KeyboardEvent(type, { key: "Enter", repeat, bubbles: true, cancelable: true }));
        let machineKeys;

        beforeEach(() => {
            machineKeys = vi.fn();
            document.addEventListener("keydown", machineKeys);
        });

        afterEach(() => document.removeEventListener("keydown", machineKeys));

        it("does not repeat into the machine, until it is let go", async () => {
            new SessionDialog({ session: null, refusal: null, host, join });
            await openDialog();
            await startHosting(0);
            enter("keydown", true);
            enter("keydown", true);
            expect(machineKeys).not.toHaveBeenCalled();
            enter("keyup");
            enter("keydown");
            enter("keydown", true);
            expect(machineKeys).toHaveBeenCalledTimes(2);
        });

        it("is no concern when the button was clicked", async () => {
            new SessionDialog({ session: null, refusal: null, host, join });
            await openDialog();
            await startHosting(1);
            enter("keydown", true);
            expect(machineKeys).toHaveBeenCalledOnce();
        });
    });

    it.each([
        ["a room's name", "  brave-owls-sing ", "brave-owls-sing"],
        ["a link to join", "https://bbc.xania.org/?client=brave-owls-sing&model=Master", "brave-owls-sing"],
    ])("joins from %s", (_, text, room) => {
        new SessionDialog({ session: null, refusal: null, host, join });
        find(".session-name").value = " matt ";
        submitJoin(text);
        expect(join).toHaveBeenCalledWith(room, "matt");
        expect(find(".session-room").classList).not.toContain("is-invalid");
    });

    it("goes nowhere with something that is not a room, and says so until it is changed", () => {
        new SessionDialog({ session: null, refusal: null, host, join });
        submitJoin("brave owls sing!");
        expect(join).not.toHaveBeenCalled();
        const room = find(".session-room");
        expect(room.classList).toContain("is-invalid");
        room.dispatchEvent(new Event("input"));
        expect(room.classList).not.toContain("is-invalid");
    });

    it.each([
        ["says why a machine that cannot take part can neither host nor join", "No Atoms."],
        ["keeps the refusal out of the way, and lets it host or join, when there is none", null],
    ])("%s", (_, refusal) => {
        new SessionDialog({ session: null, refusal, host, join });
        const refused = refusal !== null;
        expect(find(".session-refusal").hidden).toBe(!refused);
        expect(find(".session-refusal").textContent).toBe(refusal ?? "");
        expect(find(".session-host").disabled).toBe(refused);
        expect(find(".session-join").disabled).toBe(refused);
    });
});
