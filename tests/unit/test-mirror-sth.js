import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, HttpError, isTransient, parseZipLinks } from "../../tools/mirror-sth.js";

const DiskIndex = "https://www.stairwaytohell.com/bbc/archive/diskimages/reclist.php?sort=name&filter=.zip";
const DiskFiles = "https://www.stairwaytohell.com/bbc/archive/diskimages/";

// A `reclist.php` row: size, date, then the download link followed by a link to
// the publisher's directory.
const reclistRow = (path, name, publisher) =>
    `<tr><td align=right><PRE>5914</td>
    <td><PRE>Jul 10 2006 23:01:40 </td>
    <td><PRE><a href="${path}">${name}</a>&nbsp;<FONT SIZE=-1>(<a href="${publisher}">${publisher}</a>)</td>
</tr>`;

describe("parseZipLinks", () => {
    it("finds the downloads in a reclist.php table", () => {
        const html = [
            reclistRow("AnF/180Darts.zip", "180Darts.zip", "AnF"),
            reclistRow("Acornsoft/Elite.zip", "Elite.zip", "Acornsoft"),
        ].join("\n");

        expect(parseZipLinks(html, DiskIndex, DiskFiles)).toEqual(["Acornsoft/Elite.zip", "AnF/180Darts.zip"]);
    });

    it("ignores reclist.php's own sort links, which end in .zip via the query string", () => {
        const html = `<a href="reclist.php?sort=size&filter=.zip">index by size</a>
            <a href="reclist.php?sort=date&filter=.zip">index by date</a>
            ${reclistRow("Acornsoft/Elite.zip", "Elite.zip", "Acornsoft")}`;

        expect(parseZipLinks(html, DiskIndex, DiskFiles)).toEqual(["Acornsoft/Elite.zip"]);
    });

    it("keeps brackets in filenames as written upstream, since sth: URLs embed them", () => {
        const html = `<a href="Unreleased/Daxis[droids]-demo.zip">Daxis[droids]-demo.zip</a>`;

        expect(parseZipLinks(html, DiskIndex, DiskFiles)).toEqual(["Unreleased/Daxis[droids]-demo.zip"]);
    });

    it("decodes escaped characters in hrefs", () => {
        const html = `<a href="Cheats/CHT_Chuckie%20Egg.zip">CHT_Chuckie Egg.zip</a>`;

        expect(parseZipLinks(html, DiskIndex, DiskFiles)).toEqual(["Cheats/CHT_Chuckie Egg.zip"]);
    });

    it("ignores links pointing outside the category", () => {
        // roms/homepage.html links across to a file that belongs to the
        // electron/uefarchive category; it must not be counted twice.
        const romsIndex = "https://www.stairwaytohell.com/roms/homepage.html";
        const romsFiles = "https://www.stairwaytohell.com/roms/";
        const html = `<a href="ADFS-1.30.zip">ADFS</a>
            <a href="../electron/uefarchive/Hewson/Uridium.zip">Uridium</a>
            <a href="https://example.com/elsewhere.zip">elsewhere</a>
            <a href="/absolute.zip">absolute</a>`;

        expect(parseZipLinks(html, romsIndex, romsFiles)).toEqual(["ADFS-1.30.zip"]);
    });

    it("strips the shared prefix when the index page sits above the files", () => {
        // bbc/sthcollection.html indexes files living in bbc/sthcollection/.
        const index = "https://www.stairwaytohell.com/bbc/sthcollection.html";
        const files = "https://www.stairwaytohell.com/bbc/sthcollection/";
        const html = `<a href="sthcollection/A1_r1.zip">A1</a><a href="diskimages.html">disk images</a>`;

        expect(parseZipLinks(html, index, files)).toEqual(["A1_r1.zip"]);
    });

    it("deduplicates repeated links", () => {
        const html = `<a href="Acornsoft/Elite.zip">Elite</a><a href="Acornsoft/Elite.zip">Elite again</a>`;

        expect(parseZipLinks(html, DiskIndex, DiskFiles)).toEqual(["Acornsoft/Elite.zip"]);
    });

    it("rewrites paths an index page spells wrongly, and keeps them sorted", () => {
        const html = `<a href="new/Exile_E.zip">Exile</a><a href="New/LazerChess.zip">Lazer Chess</a>`;

        expect(parseZipLinks(html, DiskIndex, DiskFiles, { "new/Exile_E.zip": "New/Exile_E.zip" })).toEqual([
            "New/Exile_E.zip",
            "New/LazerChess.zip",
        ]);
    });

    it("collapses a correction onto the same file listed correctly elsewhere", () => {
        const html = `<a href="new/Exile_E.zip">Exile</a><a href="New/Exile_E.zip">Exile again</a>`;

        expect(parseZipLinks(html, DiskIndex, DiskFiles, { "new/Exile_E.zip": "New/Exile_E.zip" })).toEqual([
            "New/Exile_E.zip",
        ]);
    });

    it("leaves paths alone when no correction applies", () => {
        const html = `<a href="Acornsoft/Elite.zip">Elite</a>`;

        expect(parseZipLinks(html, DiskIndex, DiskFiles, { "other/Thing.zip": "Other/Thing.zip" })).toEqual([
            "Acornsoft/Elite.zip",
        ]);
    });
});

describe("fetchWithRetry", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const respond = (status) => ({ ok: status >= 200 && status < 300, status });

    it("does not retry a 404 — a file the index promised is a fault to report, not a blip", async () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(404));

        await expect(fetchWithRetry("https://example.com/gone.zip", 0)).rejects.toThrow("HTTP 404");
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("retries a 5xx and succeeds once the server recovers", async () => {
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(respond(503))
            .mockResolvedValueOnce(respond(500))
            .mockResolvedValue(respond(200));

        await expect(fetchWithRetry("https://example.com/flaky.zip", 0)).resolves.toMatchObject({ status: 200 });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("retries a dropped connection", async () => {
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValue(respond(200));

        await expect(fetchWithRetry("https://example.com/slow.zip", 0)).resolves.toMatchObject({ status: 200 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("gives up rather than hammering a server that stays broken", async () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(503));

        await expect(fetchWithRetry("https://example.com/down.zip", 0)).rejects.toThrow("HTTP 503");
        expect(fetch).toHaveBeenCalledTimes(4); // the first try plus MaxRetries
    });
});

describe("isTransient", () => {
    it.each([
        [503, true],
        [500, true],
        [429, true],
        [404, false],
        [403, false],
    ])("treats HTTP %i as transient=%s", (status, expected) => {
        expect(isTransient(new HttpError(status, "https://example.com/x.zip"))).toBe(expected);
    });

    it("treats a non-HTTP failure as transient", () => {
        expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    });
});
