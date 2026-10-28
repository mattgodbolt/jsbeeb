import { afterEach, describe, expect, it, vi } from "vitest";

import { createZipBlob } from "../../src/archive.js";
import { MediaResolver, openIfZip, splitImage } from "../../src/media-resolver.js";

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

describe("openIfZip", () => {
    it("fails a zip that is not one as a bad image", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        await expect(openIfZip("x.zip", new Uint8Array(10))).rejects.toMatchObject({ loadFailure: "bad_image" });
        vi.restoreAllMocks();
    });

    it("leaves anything else as it is", () => {
        const data = new Uint8Array(10);
        expect(openIfZip("x.ssd", data)).toEqual({ name: "x.ssd", data, ignored: [] });
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

        describe("at @~latest", () => {
            const Api = "https://api.github.com/repos";
            const release = (tag) => bytes(JSON.stringify({ tag_name: tag }));

            afterEach(() => vi.restoreAllMocks());

            it("loads the raw file at the latest release's tag, asking the API once per repo", async () => {
                const { resolver, load } = make({
                    [`${Api}/o/r/releases/latest`]: release("v1.2"),
                    [`${Raw}/o/r/v1.2/game.ssd`]: bytes("game"),
                    [`${Raw}/o/r/v1.2/other.ssd`]: bytes("other"),
                });
                expect(await resolver.resolve("disc", "github:o/r@~latest/game.ssd")).toEqual({
                    name: "game.ssd",
                    data: bytes("game"),
                    ignored: [],
                });
                expect((await resolver.resolve("disc", "github:o/r@~latest/other.ssd")).data).toEqual(bytes("other"));
                expect(load.mock.calls.map(([url]) => url)).toEqual([
                    `${Api}/o/r/releases/latest`,
                    `${Raw}/o/r/v1.2/game.ssd`,
                    `${Raw}/o/r/v1.2/other.ssd`,
                ]);
            });

            it("shares one API call between references resolved at once, and asks each repo apart", async () => {
                const { resolver, load } = make({
                    [`${Api}/o/r/releases/latest`]: release("v1"),
                    [`${Api}/o/s/releases/latest`]: release("release/2"),
                    [`${Raw}/o/r/v1/a.ssd`]: bytes("a"),
                    [`${Raw}/o/r/v1/b.ssd`]: bytes("b"),
                    [`${Raw}/o/s/release%2F2/c.ssd`]: bytes("c"),
                });
                const resolved = await Promise.all(
                    ["o/r@~latest/a.ssd", "o/r@~latest/b.ssd", "o/s@~latest/c.ssd"].map((location) =>
                        resolver.resolve("disc", `github:${location}`),
                    ),
                );
                expect(resolved.map(({ data }) => data)).toEqual([bytes("a"), bytes("b"), bytes("c")]);
                expect(load.mock.calls.filter(([url]) => url.startsWith(Api))).toHaveLength(2);
            });

            it("falls back to the default branch, with one warning, when the API will not say", async () => {
                const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
                const { resolver, load } = make({ [`${Raw}/o/r/HEAD/game.ssd`]: bytes("head") });
                expect((await resolver.resolve("disc", "github:o/r@~latest/game.ssd")).data).toEqual(bytes("head"));
                expect((await resolver.resolve("disc", "github:o/r@~latest/game.ssd")).data).toEqual(bytes("head"));
                expect(warn).toHaveBeenCalledOnce();
                expect(warn.mock.calls[0][0]).toContain("o/r's latest release");
                expect(load.mock.calls.filter(([url]) => url.startsWith(Api))).toHaveLength(1);
            });

            it("falls back to the default branch when the answer names no tag", async () => {
                vi.spyOn(console, "warn").mockImplementation(() => {});
                const { resolver } = make({
                    [`${Api}/o/r/releases/latest`]: bytes(JSON.stringify({ message: "Not Found" })),
                    [`${Raw}/o/r/HEAD/game.ssd`]: bytes("head"),
                });
                expect((await resolver.resolve("disc", "github:o/r@~latest/game.ssd")).data).toEqual(bytes("head"));
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

    describe("a sideways ROM", () => {
        it("takes a bare name from the built-in ROMs and a github: reference from the repo", async () => {
            const { resolver, load } = make({
                "roms/ample.rom": bytes("ample"),
                "https://raw.githubusercontent.com/mattgodbolt/xmos/HEAD/original.rom": bytes("xmos"),
            });
            expect((await resolver.resolve("rom", "ample.rom")).data).toEqual(bytes("ample"));
            expect(await resolver.resolve("rom", "github:mattgodbolt/xmos/original.rom")).toEqual({
                name: "original.rom",
                data: bytes("xmos"),
                ignored: [],
            });
            expect(load).toHaveBeenCalledTimes(2);
        });

        it("opens a zip for the ROM in it, passing over a disc", async () => {
            const zip = await zipOf([
                ["readme.ssd", "disc"],
                ["thing.rom", "rom"],
            ]);
            const { resolver } = make({ "https://raw.githubusercontent.com/o/r/HEAD/thing.zip": zip });
            expect(await resolver.resolve("rom", "github:o/r/thing.zip")).toEqual({
                name: "thing.rom",
                data: bytes("rom"),
                ignored: [],
            });
        });

        it("says Stairway to Hell has none", async () => {
            const { resolver } = make();
            await expect(resolver.resolve("rom", "sth:ELITE.zip")).rejects.toThrow(
                'Stairway to Hell has no rom images, so "sth:ELITE.zip" cannot be loaded',
            );
        });
    });

    it("says when an archive has not been registered", async () => {
        const { resolver } = make();
        await expect(resolver.resolve("disc", "sth:ELITE.zip")).rejects.toThrow("No sth archive is available here");
    });
});
