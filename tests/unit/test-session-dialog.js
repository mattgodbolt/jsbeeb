// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDialog } from "../../src/web/session-dialog.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("SessionDialog", () => {
    let host;
    let join;
    let session;

    beforeEach(() => {
        domFromIndexHtml("session-open", "session-dialog");
        session = { panel: { open: vi.fn() } };
        host = vi.fn(() => session);
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
    const openIt = () => document.getElementById("session-open").click();
    const submitJoin = (text) => {
        find(".session-room").value = text;
        find(".session-join-form").requestSubmit();
    };

    it("opens the dialog when there is no session", () => {
        new SessionDialog({ session: null, refusal: null, host, join });
        const show = shown();
        openIt();
        expect(show).toHaveBeenCalled();
    });

    it("opens the session's pane instead while there is one", () => {
        new SessionDialog({ session, refusal: null, host, join });
        const show = shown();
        openIt();
        expect(session.panel.open).toHaveBeenCalled();
        expect(show).not.toHaveBeenCalled();
    });

    it("hosts as the name given, and opens the pane next time", () => {
        new SessionDialog({ session: null, refusal: null, host, join });
        find(".session-name").value = "matt";
        find(".session-host").click();
        expect(host).toHaveBeenCalledWith("matt");
        openIt();
        expect(session.panel.open).toHaveBeenCalled();
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

    it("says why a machine that cannot take part can neither host nor join", () => {
        new SessionDialog({ session: null, refusal: "No Atoms.", host, join });
        expect(find(".session-refusal").hidden).toBe(false);
        expect(find(".session-refusal").textContent).toBe("No Atoms.");
        expect(find(".session-host").disabled).toBe(true);
        expect(find(".session-join").disabled).toBe(true);
    });

    it("keeps the refusal out of the way when there is none", () => {
        new SessionDialog({ session: null, refusal: null, host, join });
        expect(find(".session-refusal").hidden).toBe(true);
    });
});
