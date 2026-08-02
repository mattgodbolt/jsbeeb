import { describe, expect, it } from "vitest";
import { parseZipLinks } from "../../tools/mirror-sth.js";

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
});
