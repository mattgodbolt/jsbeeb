import { describe, expect, it, vi } from "vitest";

import GitHubDiscs from "../../src/web/github-discs.json";
import { GitHubSource } from "../../src/web/github-source.js";
import { MachineRequirements, describeGitHubEntry } from "../../src/web/media-catalogue.js";

describe("GitHubSource", () => {
    const make = () => {
        const media = { addSource: vi.fn(), addLister: vi.fn(), addDescriber: vi.fn() };
        new GitHubSource({ media });
        return media;
    };

    it("registers no fetcher, since the resolver loads any github: reference by its URL", () => {
        expect(make().addSource).not.toHaveBeenCalled();
    });

    it("lists every disc in the bundled list for the media window", async () => {
        const [name, lister] = make().addLister.mock.calls[0];
        expect(name).toBe("github");
        const listed = await lister();
        expect(listed).toEqual(GitHubDiscs.map(describeGitHubEntry));
        expect(listed.every((d) => d.source === "github" && d.ref.startsWith("github:"))).toBe(true);
    });

    it("describes a listed disc by its reference, with the machine it needs", async () => {
        const [name, describer] = make().addDescriber.mock.calls[0];
        expect(name).toBe("github");
        expect(await describer("mattgodbolt/nm/ninja_music.ssd")).toMatchObject({
            title: "Ninja Massacre music",
            requires: MachineRequirements.Master,
        });
        expect(await describer("mattgodbolt/frogman@classic/frogman_rebuilt.ssd")).toMatchObject({
            title: "Frogman (classic)",
        });
        expect(await describer("someone/else/disc.ssd")).toBeUndefined();
    });

    describe("the bundled list", () => {
        const Required = ["repo", "path", "title", "publisher", "year", "type"];
        const Known = new Set([...Required, "ref", "authors", "machine", "url"]);

        it.each(GitHubDiscs.map((entry) => [describeGitHubEntry(entry).ref, entry]))(
            "%s has what an entry needs, and nothing the list does not know",
            (_name, entry) => {
                for (const field of Required) expect(entry[field], field).toBeTruthy();
                expect(Object.keys(entry).filter((field) => !Known.has(field))).toEqual([]);
                expect(entry.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
                expect(entry.path).not.toMatch(/^\//);
                expect(Number.isInteger(entry.year)).toBe(true);
                if (entry.ref !== undefined) expect(entry.ref).toMatch(/^[^/\s]+$/);
                if (entry.machine !== undefined) expect(Object.keys(MachineRequirements)).toContain(entry.machine);
                if (entry.url !== undefined) expect(new URL(entry.url).protocol).toBe("https:");
            },
        );

        it("names each disc once", () => {
            const refs = GitHubDiscs.map((entry) => describeGitHubEntry(entry).ref);
            expect(new Set(refs).size).toBe(refs.length);
        });
    });
});
