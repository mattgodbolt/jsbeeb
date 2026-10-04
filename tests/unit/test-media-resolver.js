import { describe, expect, it, vi } from "vitest";

import { createZipBlob } from "../../src/archive.js";
import { MediaResolver, splitImage } from "../../src/media-resolver.js";

describe("splitImage", () => {
    it.each([
        ["sth:ELITE.zip", "sth", "ELITE.zip"],
        ["|ELITE.zip", "|", "ELITE.zip"],
        ["hfe:3A1DAB83.hfe", "hfe", "3A1DAB83.hfe"],
        ["bitshifters:bs-paradroid.ssd", "bitshifters", "bs-paradroid.ssd"],
        ["github:mattgodbolt/frogman@classic/frogman.ssd", "github", "mattgodbolt/frogman@classic/frogman.ssd"],
        ["gd:abc123/name.ssd", "gd", "abc123/name.ssd"],
        ["local:mydisc", "local", "mydisc"],
        ["!mydisc", "!", "mydisc"],
        ["https://example.com/a.ssd", "https", "example.com/a.ssd"],
        ["elite.ssd", "", "elite.ssd"],
    ])("splits %s into schema %j and image %j", (ref, schema, image) => {
        expect(splitImage(ref)).toEqual({ schema, image });
    });
});

describe("MediaResolver", () => {
    const bytes = (text) => new TextEncoder().encode(text);
    const zipOf = async (files) =>
        new Uint8Array(await createZipBlob(files.map(([name, text]) => ({ name, data: bytes(text) }))).arrayBuffer());
    const make = (files = {}) => {
        const load = vi.fn(async (url) => {
            if (!(url in files)) throw new Error(`Unable to load ${url}, http code 404`);
            return files[url];
        });
        return { resolver: new MediaResolver({ load }), load };
    };

    it("takes a bare disc name from the built-in discs and a bare tape name from the tapes", async () => {
        const { resolver, load } = make({ "discs/elite.ssd": bytes("disc"), "tapes/game.uef": bytes("tape") });
        expect(await resolver.resolve("disc", "elite.ssd")).toEqual({
            name: "elite.ssd",
            data: bytes("disc"),
            ignored: [],
        });
        expect(await resolver.resolve("tape", "game.uef")).toEqual({
            name: "game.uef",
            data: bytes("tape"),
            ignored: [],
        });
        expect(load.mock.calls.map(([url]) => url)).toEqual(["discs/elite.ssd", "tapes/game.uef"]);
    });

    it("fetches a URL as given, keeping only its file name as the name", async () => {
        const { resolver, load } = make({
            "https://example.com/dir/a.ssd?v=2": bytes("x"),
            "file:///tmp/b.ssd": bytes("y"),
        });
        const { name } = await resolver.resolve("disc", "https://example.com/dir/a.ssd?v=2");
        expect(name).toBe("a.ssd");
        expect((await resolver.resolve("disc", "file:///tmp/b.ssd")).name).toBe("b.ssd");
        expect(load).toHaveBeenLastCalledWith("file:///tmp/b.ssd");
    });

    describe("a github: reference", () => {
        const Raw = "https://raw.githubusercontent.com";

        it("loads the raw file at the repo's default branch, or at the ref after an @, disc or tape", async () => {
            const { resolver, load } = make({
                [`${Raw}/mattgodbolt/frogman/HEAD/frogman_rebuilt.ssd`]: bytes("latest"),
                [`${Raw}/mattgodbolt/frogman/classic/frogman_rebuilt.ssd`]: bytes("classic"),
                [`${Raw}/o/r/HEAD/tapes/game.uef`]: bytes("tape"),
            });
            expect(await resolver.resolve("disc", "github:mattgodbolt/frogman/frogman_rebuilt.ssd")).toEqual({
                name: "frogman_rebuilt.ssd",
                data: bytes("latest"),
                ignored: [],
            });
            const classic = await resolver.resolve("disc", "github:mattgodbolt/frogman@classic/frogman_rebuilt.ssd");
            expect(classic.data).toEqual(bytes("classic"));
            expect((await resolver.resolve("tape", "github:o/r/tapes/game.uef")).name).toBe("game.uef");
            expect(load).toHaveBeenCalledTimes(3);
        });

        it("encodes each segment of the path, and names the image as the repo does", async () => {
            const { resolver, load } = make({
                [`${Raw}/kieranhj/Atomic-AGD-Suite/HEAD/BBC%20Suite/Discs/cambridge%20disc.ssd`]: bytes("c"),
                [`${Raw}/o/r/v1.0%231/a%3Fb.ssd`]: bytes("q"),
            });
            const { name } = await resolver.resolve(
                "disc",
                "github:kieranhj/Atomic-AGD-Suite/BBC Suite/Discs/cambridge disc.ssd",
            );
            expect(name).toBe("cambridge disc.ssd");
            expect((await resolver.resolve("disc", "github:o/r@v1.0#1/a?b.ssd")).name).toBe("a?b.ssd");
            expect(load).toHaveBeenCalledTimes(2);
        });

        it("opens a zip as a URL's would be opened", async () => {
            const zip = await zipOf([
                ["side1.ssd", "one"],
                ["side2.ssd", "two"],
            ]);
            const { resolver } = make({ [`${Raw}/o/r/HEAD/game.zip`]: zip });
            expect(await resolver.resolve("disc", "github:o/r/game.zip")).toEqual({
                name: "side1.ssd",
                data: bytes("one"),
                ignored: ["side2.ssd"],
            });
        });

        it.each(["github:mattgodbolt/frogman", "github:mattgodbolt/frogman/", "github:o/r@/x.ssd", "github:o@r/x.ssd"])(
            "says what a reference should look like when %s is not one",
            async (ref) => {
                const { resolver, load } = make();
                await expect(resolver.resolve("disc", ref)).rejects.toThrow(
                    "A github: reference is owner/repo/path or owner/repo@ref/path",
                );
                expect(load).not.toHaveBeenCalled();
            },
        );
    });

    it("opens a zip once, wherever it came from, and names what it passed over", async () => {
        const zip = await zipOf([
            ["side1.ssd", "one"],
            ["side2.ssd", "two"],
        ]);
        const { resolver } = make({ "discs/game.zip": zip });
        const fromFolder = await resolver.resolve("disc", "game.zip");
        expect(fromFolder).toEqual({ name: "side1.ssd", data: bytes("one"), ignored: ["side2.ssd"] });
        const inline = await resolver.resolve("disc", `data:${btoa(String.fromCharCode(...zip))}`);
        expect(inline.name).toBe("side1.ssd");
    });

    it("decodes a b64data disc as a plain SSD", async () => {
        const { resolver } = make();
        expect(await resolver.resolve("disc", `b64data:${btoa("raw")}`)).toEqual({
            name: "disk.ssd",
            data: bytes("raw"),
            ignored: [],
        });
    });

    it("hands the archives to their sources, disc and tape apart", async () => {
        const { resolver } = make();
        const sth = vi.fn(async () => ({ name: "ELITE.ssd", data: bytes("e"), ignored: [] }));
        const tapeSth = vi.fn(async () => ({ name: "ELITE.uef", data: bytes("t"), ignored: [] }));
        const hfe = vi.fn(async () => bytes("h"));
        const bitshifters = vi.fn(async () => bytes("b"));
        resolver.addSource("sth", sth);
        resolver.addSource("tapeSth", tapeSth);
        resolver.addSource("hfe", hfe);
        resolver.addSource("bitshifters", bitshifters);
        await resolver.resolve("disc", "sth:ELITE.zip");
        await resolver.resolve("tape", "|ELITE.zip");
        expect(sth).toHaveBeenCalledWith("ELITE.zip");
        expect(tapeSth).toHaveBeenCalledWith("ELITE.zip");
        expect(await resolver.resolve("disc", "hfe:3A1DAB83.hfe")).toEqual({
            name: "3A1DAB83.hfe",
            data: bytes("h"),
            ignored: [],
        });
        expect(await resolver.resolve("disc", "bitshifters:bs-paradroid.ssd")).toEqual({
            name: "bs-paradroid.ssd",
            data: bytes("b"),
            ignored: [],
        });
        expect(bitshifters).toHaveBeenCalledWith("bs-paradroid.ssd");
    });

    it("hands a session: reference to the session source, whatever the kind", async () => {
        const { resolver } = make();
        const session = vi.fn(async (name) => ({ name, data: bytes("s"), ignored: [] }));
        resolver.addSource("session", session);
        expect((await resolver.resolve("disc", "session:mine.ssd")).name).toBe("mine.ssd");
        expect((await resolver.resolve("tape", "session:mine.uef")).name).toBe("mine.uef");
        expect(session).toHaveBeenCalledTimes(2);
    });

    it("says when an archive has not been registered", async () => {
        const { resolver } = make();
        await expect(resolver.resolve("disc", "sth:ELITE.zip")).rejects.toThrow("No sth archive is available here");
    });
});
