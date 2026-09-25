#!/usr/bin/env node
// Prints the numbers from a boot survey: how each model's boots ended, the discs
// that behave differently on the two, what the discs that fail on both have in
// common, how settled the outcomes are by the end of the run, and whether the
// screen names discs whose catalogue title doesn't.
//
//   node tools/registry/boot-survey-analyse.js [--survey .registry-corpus/boot-survey.jsonl] [--examples]
//
// Examples are only ever printed for our own mirrors' images, never bbcmicro.co.uk's.

import { readFileSync } from "node:fs";
import { classify } from "./boot-survey.js";

const Models = ["B-DFS1.2", "Master"];
const Booted = new Set(["input", "running-ram", "running-basic"]);
// Mostly in the MOS: a program waiting on the OS, or a loader stuck in it; the survey can't tell.
const Unclear = new Set(["running-os"]);
// The checkpoints at 10 and 20 s were recorded with one label for every run mostly in ROM.
const CheckpointBooted = new Set(["input", "running-ram", "running-basic", "running-rom", "running-os"]);
const MinWordLength = 4;
// What our mirrors' notes and names say about which machine a disc needs.
const MachineClaim =
    /master compat|not master|fails.{0,15}model b|ok on (the )?master|model b compat|not model b|b\+ ?\/ ?master|master version|\bmaster\)|bbc master/i;
const MachineName = /CHT-MASTER_|BPlusMaster|MasterAndTube/;
// Words that turn up on title screens and in titles alike and so prove nothing.
const CommonWords = new Set(["disc", "disk", "side", "game", "games", "part", "demo", "master", "program", "version"]);

export const booted = (run) => Booted.has(run.state);
export const failed = (run) => !Booted.has(run.state) && !Unclear.has(run.state);

export function titleWords(title) {
    return (title ?? "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= MinWordLength && !CommonWords.has(word) && !/^\d+$/.test(word));
}

// A name for the disc from where it came from: the mirror's title, or the file name.
export function knownTitle(run) {
    if (run.title) return run.title;
    const file = run.ref.split("#").pop().split("/").pop();
    return file
        .replace(/\.[a-z]+$/i, "")
        .replace(/-\d+$/, "")
        .replace(/^CHT_/, "");
}

// A DFS title that says nothing: empty, or without a run of three letters.
export const junkDfsTitle = (title) => !/[A-Za-z]{3}/.test(title ?? "");

// Leaves out the command lines a !BOOT echoes, which name files rather than show a title.
export const displayedText = (text) =>
    text
        .split("\n")
        .filter((line) => !/^\s*[>*]/.test(line))
        .join("\n")
        .toLowerCase();

function percent(n, of) {
    return `${n} (${of ? ((100 * n) / of).toFixed(1) : "0.0"}%)`;
}

function tally(items, keyOf) {
    const counts = new Map();
    for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
    const args = process.argv.slice(2);
    const surveyIndex = args.indexOf("--survey");
    const surveyPath = surveyIndex >= 0 ? args[surveyIndex + 1] : ".registry-corpus/boot-survey.jsonl";
    const showExamples = args.includes("--examples");
    const runs = readFileSync(surveyPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map((run) => (run.state === "failed" ? run : { ...run, state: classify(run, run.transcript ?? "") }));

    const discs = new Map();
    for (const run of runs) {
        if (!discs.has(run.discKey)) discs.set(run.discKey, {});
        discs.get(run.discKey)[run.model] = run;
    }
    const pairs = [...discs.values()].filter((d) => Models.every((m) => d[m]));
    console.log(`${runs.length} runs, ${pairs.length} discs run on both models`);

    console.log("\n## How each boot ended");
    for (const model of Models) {
        const mine = pairs.map((d) => d[model]);
        console.log(`\n${model}: booted to something ${percent(mine.filter(booted).length, mine.length)}`);
        console.log(`  clearly failed ${percent(mine.filter(failed).length, mine.length)}`);
        for (const [state, n] of tally(mine, (r) => r.state))
            console.log(`  ${state.padEnd(14)} ${percent(n, mine.length)}`);
        for (const source of ["hfe", "sth", "bbcmicro"]) {
            const fromSource = mine.filter((r) => r.source === source);
            console.log(
                `  from ${source.padEnd(9)} booted ${percent(fromSource.filter(booted).length, fromSource.length)}`,
            );
        }
        const autoboot = mine.filter((r) => r.bootOption === 2 || r.bootOption === 3);
        console.log(`  with boot option 2 or 3, booted ${percent(autoboot.filter(booted).length, autoboot.length)}`);
        console.log(`  booted but error text on the way: ${mine.filter((r) => booted(r) && r.error).length}`);
        const errors = mine.filter((r) => !booted(r) && r.error);
        console.log(`  not booted with error text: ${errors.length}`);
        for (const [error, n] of tally(errors, (r) => r.error.trim()).slice(0, 8)) console.log(`    ${error}: ${n}`);
    }

    console.log("\n## Settling: the state at 20 s against 30 s");
    for (const model of Models) {
        const mine = pairs.map((d) => d[model]);
        const final = (r) => r.checkpoints?.[r.seconds];
        const at = (r, t) => CheckpointBooted.has(r.checkpoints?.[t]);
        const changed10 = mine.filter((r) => at(r, "10") !== at(r, r.seconds)).length;
        const changed20 = mine.filter((r) => at(r, "20") !== at(r, r.seconds)).length;
        const stateChanged20 = mine.filter((r) => r.checkpoints?.["20"] !== final(r)).length;
        console.log(
            `${model}: booted-or-not differs from the end at 10 s for ${changed10}, at 20 s for ${changed20}; ` +
                `exact state differs at 20 s for ${stateChanged20}`,
        );
    }

    console.log("\n## The two models against each other");
    const both = pairs.filter((d) => booted(d["B-DFS1.2"]) && booted(d.Master));
    const bOnly = pairs.filter((d) => booted(d["B-DFS1.2"]) && failed(d.Master));
    const masterOnly = pairs.filter((d) => failed(d["B-DFS1.2"]) && booted(d.Master));
    const neither = pairs.filter((d) => failed(d["B-DFS1.2"]) && failed(d.Master));
    console.log(`both ${percent(both.length, pairs.length)}`);
    console.log(`B only ${percent(bOnly.length, pairs.length)}`);
    console.log(`Master only ${percent(masterOnly.length, pairs.length)}`);
    console.log(`neither ${percent(neither.length, pairs.length)}`);
    console.log(
        `the rest, with at least one unclear ${percent(pairs.length - both.length - bOnly.length - masterOnly.length - neither.length, pairs.length)}`,
    );
    for (const [label, group] of [
        ["B only", bOnly],
        ["Master only", masterOnly],
    ]) {
        console.log(
            `\n${label}, by source: ${tally(group, (d) => d.Master.source)
                .map(([s, n]) => `${s} ${n}`)
                .join(", ")}`,
        );
        console.log(`  how the other model ended:`);
        const other = label === "B only" ? "Master" : "B-DFS1.2";
        for (const [state, n] of tally(
            group,
            (d) => `${d[other].state}${d[other].error ? ` (${d[other].error.trim()})` : ""}`,
        ).slice(0, 10))
            console.log(`    ${state}: ${n}`);
        if (showExamples) {
            for (const d of group.filter((d) => d.Master.source !== "bbcmicro").slice(0, 40)) {
                const o = d[other];
                console.log(`    ${knownTitle(d.Master)} [${d.Master.ref}] other: ${o.state} ${o.error ?? ""}`);
            }
        }
    }

    console.log("\n## Neither model");
    console.log(
        `by source: ${tally(neither, (d) => d.Master.source)
            .map(([s, n]) => `${s} ${n}`)
            .join(", ")}`,
    );
    console.log(
        `by boot option: ${tally(neither, (d) => d.Master.bootOption)
            .map(([s, n]) => `${s} ${n}`)
            .join(", ")}`,
    );
    const neitherBootable = neither.filter((d) => d.Master.bootOption === 3 || d.Master.bootOption === 2);
    console.log(`with boot option 2 or 3: ${neitherBootable.length}`);
    for (const [pair, n] of tally(neitherBootable, (d) =>
        Models.map((m) => `${d[m].state}${d[m].error ? `/${d[m].error.trim()}` : ""}`).join(" + "),
    ).slice(0, 12))
        console.log(`  ${pair}: ${n}`);
    const secondDisc = neitherBootable.filter((d) => /\b(disc|disk|side)\s*(2|b|two)\b/i.test(knownTitle(d.Master)));
    console.log(`  named as a second disc or side: ${secondDisc.length}`);
    if (showExamples) {
        for (const d of neitherBootable.filter((d) => d.Master.source !== "bbcmicro").slice(0, 40)) {
            console.log(
                `    ${knownTitle(d.Master)} [${d.Master.ref}] ${Models.map((m) => `${d[m].state} ${d[m].error ?? ""}`).join(" | ")}`,
            );
        }
    }

    console.log("\n## Recognising a disc from its screen");
    const namedOnScreen = (d, titleFrom = d) => {
        const words = titleWords(knownTitle(titleFrom.Master));
        const text = displayedText(Models.map((m) => `${d[m].screenText}\n${d[m].transcript}`).join("\n"));
        return words.some((word) => new RegExp(`\\b${word}`).test(text));
    };
    const candidates = pairs.filter((d) => titleWords(knownTitle(d.Master)).length > 0);
    for (const [label, group] of [
        ["catalogue title junk or blank", candidates.filter((d) => junkDfsTitle(d.Master.dfsTitle))],
        [
            "catalogue title shares no word with the known title",
            candidates.filter(
                (d) =>
                    !junkDfsTitle(d.Master.dfsTitle) &&
                    !titleWords(knownTitle(d.Master)).some((w) => (d.Master.dfsTitle ?? "").toLowerCase().includes(w)),
            ),
        ],
        ["all discs with a usable known title", candidates],
    ]) {
        const bootedGroup = group.filter((d) => booted(d["B-DFS1.2"]) || booted(d.Master));
        console.log(
            `${label}: ${group.length}, booted on either ${bootedGroup.length}, ` +
                `known title on screen ${percent(bootedGroup.filter((d) => namedOnScreen(d)).length, bootedGroup.length)} of those booted`,
        );
        if (showExamples) {
            for (const d of bootedGroup.filter((d) => d.Master.source !== "bbcmicro" && namedOnScreen(d)).slice(0, 8))
                console.log(`    ${knownTitle(d.Master)} [dfs title ${JSON.stringify(d.Master.dfsTitle)}]`);
        }
    }

    const bootedCandidates = candidates.filter((d) => booted(d["B-DFS1.2"]) || booted(d.Master));
    const chance = bootedCandidates.filter((d, i) => {
        const other = bootedCandidates[(i * 7919 + 13) % bootedCandidates.length];
        return other !== d && namedOnScreen(d, other);
    }).length;
    console.log(`by chance: another disc's known title on screen ${percent(chance, bootedCandidates.length)}`);

    console.log("\n## Against what the mirrors say about machines");
    const indexPath = args.includes("--index") ? args[args.indexOf("--index") + 1] : ".registry-corpus/index.jsonl";
    const claims = new Map();
    for (const line of readFileSync(indexPath, "utf8").trim().split("\n")) {
        const entry = JSON.parse(line);
        if (entry.source === "bbcmicro") continue;
        const said = `${entry.meta?.title ?? entry.ref} ${entry.meta?.notes ?? ""}`;
        if (MachineClaim.test(said) || MachineName.test(entry.ref))
            claims.set(entry.discKey, said.replace(/\s+/g, " ").slice(0, 110));
    }
    const shown = (run) => `${run.state}${run.error ? `/${run.error.trim()}` : ""}`;
    for (const [discKey, said] of claims) {
        const d = discs.get(discKey);
        if (!d || !Models.every((m) => d[m])) continue;
        console.log(`  B ${shown(d["B-DFS1.2"]).padEnd(22)} Master ${shown(d.Master).padEnd(22)} ${said}`);
    }

    console.log("\n## Screen modes at the end (Master runs that booted)");
    const master = pairs.map((d) => d.Master).filter(booted);
    console.log(
        tally(master, (r) => (r.teletext ? "teletext" : `ula ${r.ulaControl.toString(16)} r1 ${r.crtc.r1}`))
            .slice(0, 10)
            .map(([k, n]) => `${k}: ${n}`)
            .join("\n"),
    );
}

if (process.argv[1]?.endsWith("boot-survey-analyse.js")) main();
