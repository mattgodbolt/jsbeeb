#!/usr/bin/env node
/**
 * Frequency-sweep test disc and capture analysis for tuning the audio path
 * against a real machine (issue #921).
 *
 *   node tools/audio-sweep.js build [sweep.ssd]      write the test disc
 *   node tools/audio-sweep.js basic                  print the BASIC program
 *   node tools/audio-sweep.js reference out.wav      run the disc headlessly, write jsbeeb's output
 *       [--model Master] [--rate 48000] [--unfiltered]
 *   node tools/audio-sweep.js analyse a.wav [b.wav]  per-step levels, and b relative to a
 *       [--channel left|right|mix|auto] [--start seconds] [--json out.json]
 *
 * The disc writes the sound chip's registers directly (not via SOUND), so every
 * step's frequency is known exactly: 4 MHz / (32 N). The schedule is defined
 * once here and shared by the BASIC program (as DATA) and the analysis.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ChipClockHz = 4000000;
export const toneHz = (period) => ChipClockHz / (32 * period);

const MarkerPeriod = 100;
const MarkerBurstCs = 10;
const MarkerBursts = 3;
const MarkerLengthCs = 100;
const SweepOnCs = 40;
const SweepOffCs = 20;
const SweepStepsPerOctave = 4;
const SweepLongestPeriod = 1023;
const SweepShortestPeriod = 5;
const QuieterAttenuations = [4, 8];
const StaircasePeriod = 100;
const ReferencePeriod = 128;
const StaircaseStepCs = 25;
const NoiseOnCs = 100;
const NoiseOffCs = 20;
const CarrierPeriods = [1, 2, 4, 8];
const CarrierRampStepCs = 6;
const CarrierOffCs = 20;
const StartDelayCs = 100;

function sweepPeriods() {
    const periods = [];
    for (let k = 0; ; ++k) {
        const period = Math.round(SweepLongestPeriod * 2 ** (-k / SweepStepsPerOctave));
        if (period < SweepShortestPeriod) break;
        if (periods.at(-1) !== period) periods.push(period);
    }
    return periods;
}

const toneBytes = (channel, period) => [0x80 | (channel << 5) | (period & 15), period >> 4];
const volumeBytes = (channel, attenuation) => [0x90 | (channel << 5) | attenuation];
const noiseBytes = (white, rate) => [0xe0 | (white ? 4 : 0) | rate];
const AllOff = [0x9f, 0xbf, 0xdf, 0xff];

/**
 * The scripted sequence. Events are register writes at a time in centiseconds
 * from the start marker; segments describe what the analysis should measure.
 */
export function buildSchedule() {
    const events = [];
    const segments = [];
    let t = 0;
    const write = (bytes) => events.push({ t, bytes });

    const marker = (label) => {
        const start = t;
        write(toneBytes(0, MarkerPeriod));
        for (let i = 0; i < MarkerBursts; ++i) {
            write(volumeBytes(0, 0));
            t += MarkerBurstCs;
            write(volumeBytes(0, 15));
            t += MarkerBurstCs;
        }
        segments.push({ kind: "marker", label, start, duration: MarkerLengthCs, period: MarkerPeriod });
        t = start + MarkerLengthCs;
    };

    const tone = (period, attenuation) => {
        write([...toneBytes(0, period), ...volumeBytes(0, attenuation)]);
        segments.push({ kind: "tone", start: t, duration: SweepOnCs, period, attenuation });
        t += SweepOnCs;
        write(volumeBytes(0, 15));
        t += SweepOffCs;
    };

    marker("start");
    const periods = sweepPeriods();
    for (const period of periods) tone(period, 0);
    for (const attenuation of QuieterAttenuations) {
        for (const period of periods.filter((_, i) => i % 2 === 0)) tone(period, attenuation);
    }

    write(toneBytes(0, StaircasePeriod));
    for (let attenuation = 0; attenuation < 16; ++attenuation) {
        write(volumeBytes(0, attenuation));
        segments.push({ kind: "staircase", start: t, duration: StaircaseStepCs, period: StaircasePeriod, attenuation });
        t += StaircaseStepCs;
    }
    t += SweepOffCs;

    const noise = (label, white, rate, tonePeriod) => {
        const bytes = [...noiseBytes(white, rate)];
        if (tonePeriod) bytes.push(...toneBytes(2, tonePeriod));
        write([...bytes, ...volumeBytes(3, 0)]);
        segments.push({ kind: "noise", label, start: t, duration: NoiseOnCs });
        t += NoiseOnCs;
        write(volumeBytes(3, 15));
        t += NoiseOffCs;
    };
    for (const rate of [0, 1, 2]) noise(`white /${16 << rate}`, true, rate);
    for (const rate of [0, 1, 2]) noise(`periodic /${16 << rate}`, false, rate);
    noise("white, tone 2 N=64", true, 3, 64);
    noise("white, tone 2 N=8", true, 3, 8);

    for (const period of CarrierPeriods) {
        const start = t;
        write(toneBytes(0, period));
        const ramp = [...Array(16).keys()].reverse().concat([...Array(16).keys()].slice(1));
        for (const attenuation of ramp) {
            write(volumeBytes(0, attenuation));
            t += CarrierRampStepCs;
        }
        segments.push({ kind: "carrier", start, duration: t - start, period });
        t += CarrierOffCs;
    }
    write(AllOff);

    marker("end");
    events.push({ t, bytes: AllOff });
    return { events, segments, totalCs: t };
}

/** The BASIC program: a register-write routine and the schedule as DATA. */
export function basicSource(schedule) {
    const lines = [
        "10 REM jsbeeb audio sweep, generated by tools/audio-sweep.js",
        "20 MODE 7:DIM M% 63,B% 8:P%=M%",
        "30 [OPT 0",
        "40 SEI:PHA:LDA #&FF:STA &FE43:PLA:STA &FE4F:LDA #0:STA &FE40",
        "50 NOP:NOP:NOP:NOP:NOP:NOP:NOP:NOP:LDA #8:STA &FE40:CLI:RTS",
        "60 ]",
        "70 A%=&9F:CALL M%:A%=&BF:CALL M%:A%=&DF:CALL M%:A%=&FF:CALL M%",
        `80 PRINT "jsbeeb audio sweep":PRINT "${schedule.events.length} events, ${(schedule.totalCs / 100).toFixed(0)} seconds"`,
        `90 E%=0:S%=TIME+${StartDelayCs}`,
        '100 READ T%:IF T%<0 THEN PRINT "Done":END',
        "110 READ N%:FOR I%=1 TO N%:READ V%:B%?I%=V%:NEXT",
        "120 REPEAT UNTIL TIME-S%>=T%",
        "130 FOR I%=1 TO N%:A%=B%?I%:CALL M%:NEXT",
        '140 E%=E%+1:PRINT TAB(0,4);"Event ";E%;" at ";T%/100;" s   ":GOTO 100',
    ];
    let lineNumber = 1000;
    let data = [];
    const flush = () => {
        if (data.length) lines.push(`${lineNumber} DATA ${data.join(",")}`);
        lineNumber += 10;
        data = [];
    };
    for (const { t, bytes } of schedule.events) {
        data.push(t, bytes.length, ...bytes.map((b) => `&${b.toString(16).toUpperCase().padStart(2, "0")}`));
        if (data.length >= 30) flush();
    }
    data.push(-1);
    flush();
    return lines.join("\n") + "\n";
}

const DfsSectorBytes = 256;
const DfsSectorsPerTrack = 10;
const DfsTracks = 80;
const DfsBootExec = 3;

/** A single-sided Acorn DFS image holding the given files, set to *EXEC !BOOT. */
export function buildSsd(files, title = "SWEEP") {
    const image = new Uint8Array(DfsTracks * DfsSectorsPerTrack * DfsSectorBytes);
    const sector0 = image.subarray(0, DfsSectorBytes);
    const sector1 = image.subarray(DfsSectorBytes, 2 * DfsSectorBytes);
    const paddedTitle = title.padEnd(12, " ");
    for (let i = 0; i < 8; ++i) sector0[i] = paddedTitle.charCodeAt(i);
    for (let i = 0; i < 4; ++i) sector1[i] = paddedTitle.charCodeAt(8 + i);
    const totalSectors = DfsTracks * DfsSectorsPerTrack;
    sector1[4] = 0;
    sector1[5] = files.length * 8;
    sector1[6] = (DfsBootExec << 4) | (totalSectors >> 8);
    sector1[7] = totalSectors & 0xff;

    let nextSector = 2;
    const placed = files.map((file) => {
        const startSector = nextSector;
        image.set(file.data, startSector * DfsSectorBytes);
        nextSector += Math.ceil(file.data.length / DfsSectorBytes);
        return { ...file, startSector };
    });
    if (nextSector > totalSectors) throw new Error("Disc image overflow");
    // The catalogue lists files by descending start sector.
    placed.reverse().forEach((file, i) => {
        const entry = 8 + i * 8;
        const name = file.name.padEnd(7, " ");
        for (let j = 0; j < 7; ++j) sector0[entry + j] = name.charCodeAt(j);
        sector0[entry + 7] = "$".charCodeAt(0);
        const length = file.data.length;
        sector1[entry] = file.load & 0xff;
        sector1[entry + 1] = (file.load >> 8) & 0xff;
        sector1[entry + 2] = file.exec & 0xff;
        sector1[entry + 3] = (file.exec >> 8) & 0xff;
        sector1[entry + 4] = length & 0xff;
        sector1[entry + 5] = (length >> 8) & 0xff;
        sector1[entry + 6] =
            (((file.exec >> 16) & 3) << 6) |
            (((length >> 16) & 3) << 4) |
            (((file.load >> 16) & 3) << 2) |
            ((file.startSector >> 8) & 3);
        sector1[entry + 7] = file.startSector & 0xff;
    });
    return image;
}

async function buildDisc() {
    const Tokeniser = await import("../src/basic-tokenise.js");
    const tokeniser = await Tokeniser.create();
    const tokenised = tokeniser.tokenise(basicSource(buildSchedule()));
    const program = Uint8Array.from(tokenised, (c) => c.charCodeAt(0));
    const boot = Uint8Array.from('*BASIC\rCHAIN "SWEEP"\r', (c) => c.charCodeAt(0));
    return buildSsd([
        { name: "!BOOT", load: 0, exec: 0, data: boot },
        { name: "SWEEP", load: 0xffff1900, exec: 0xffff8023, data: program },
    ]);
}

function writeWav(file, samples, rate) {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + samples.length * 4, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(32, 34);
    header.write("data", 36);
    header.writeUInt32LE(samples.length * 4, 40);
    fs.writeFileSync(
        file,
        Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]),
    );
}

const WaveFormatPcm = 1;
const WaveFormatFloat = 3;
const WaveFormatExtensible = 0xfffe;

/** Reads PCM or float WAV, returning one Float64Array per channel. */
export function readWav(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`${file} is not a WAV file`);
    }
    let format = null;
    let data = null;
    for (let pos = 12; pos + 8 <= buf.length;) {
        const id = buf.toString("ascii", pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        const body = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
        if (id === "fmt ") {
            format = {
                tag: body.readUInt16LE(0),
                channels: body.readUInt16LE(2),
                rate: body.readUInt32LE(4),
                bits: body.readUInt16LE(14),
            };
            if (format.tag === WaveFormatExtensible) format.tag = body.readUInt16LE(24);
        } else if (id === "data") {
            data = body;
        }
        pos += 8 + size + (size & 1);
    }
    if (!format || !data) throw new Error(`${file} has no fmt or data chunk`);
    const { tag, channels, rate, bits } = format;
    const bytesPerSample = bits / 8;
    const frames = Math.floor(data.length / (bytesPerSample * channels));
    const out = Array.from({ length: channels }, () => new Float64Array(frames));
    const read = (offset) => {
        if (tag === WaveFormatFloat) return bits === 64 ? data.readDoubleLE(offset) : data.readFloatLE(offset);
        if (tag !== WaveFormatPcm) throw new Error(`${file}: unsupported WAV format tag ${tag}`);
        if (bits === 8) return (data[offset] - 128) / 128;
        if (bits === 16) return data.readInt16LE(offset) / 32768;
        if (bits === 24) return ((data.readUIntLE(offset, 3) << 8) >> 8) / 8388608;
        if (bits === 32) return data.readInt32LE(offset) / 2147483648;
        throw new Error(`${file}: unsupported ${bits}-bit PCM`);
    };
    for (let i = 0, offset = 0; i < frames; ++i) {
        for (let c = 0; c < channels; ++c, offset += bytesPerSample) out[c][i] = read(offset);
    }
    return { rate, channels: out };
}

const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

function pickChannel(wav, choice) {
    const { channels } = wav;
    if (channels.length === 1) return { samples: channels[0], used: "mono" };
    if (choice === "left") return { samples: channels[0], used: "left" };
    if (choice === "right") return { samples: channels[1], used: "right" };
    if (choice === "mix") {
        const mix = new Float64Array(channels[0].length);
        for (const ch of channels) for (let i = 0; i < mix.length; ++i) mix[i] += ch[i] / channels.length;
        return { samples: mix, used: "mix" };
    }
    const loudest = channels.map(rms).reduce((best, v, i, all) => (v > all[best] ? i : best), 0);
    return { samples: channels[loudest], used: ["left", "right"][loudest] ?? `channel ${loudest}` };
}

/** Amplitude of a sine at hz within a Hann-windowed block: 1.0 for a full-scale sine. */
function goertzelAmplitude(x, start, length, hz, rate) {
    const w = (2 * Math.PI * hz) / rate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < length; ++i) {
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
        const s0 = (x[start + i] ?? 0) * hann + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const re = s1 - s2 * Math.cos(w);
    const im = s2 * Math.sin(w);
    return (Math.hypot(re, im) * 4) / length;
}

const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const fmtDb = (v) => db(v).toFixed(1).padStart(6);

const MarkerHopCs = 0.1;
const MarkerWindowCs = 2;

/**
 * Finds the start marker by correlating the marker tone's envelope against the
 * burst pattern; returns the sample index of its first burst and the match quality.
 */
function findMarker(samples, rate, fromSample, toSample) {
    const hop = Math.round((rate * MarkerHopCs) / 100);
    const win = Math.round((rate * MarkerWindowCs) / 100);
    const hz = toneHz(MarkerPeriod);
    const first = Math.max(0, Math.floor(fromSample / hop));
    const last = Math.min(Math.floor((samples.length - win) / hop), Math.ceil(toSample / hop));
    if (last < first) return { sample: Math.round(fromSample), quality: 0 };
    const envelope = new Float64Array(last - first + 1);
    for (let i = first; i <= last; ++i) envelope[i - first] = goertzelAmplitude(samples, i * hop, win, hz, rate);
    const template = [];
    for (let i = 0; i < MarkerBursts; ++i) {
        for (let j = 0; j < MarkerBurstCs / MarkerHopCs; ++j) template.push(1);
        for (let j = 0; j < MarkerBurstCs / MarkerHopCs; ++j) template.push(0);
    }
    const mean = template.reduce((a, b) => a + b, 0) / template.length;
    const zeroMean = template.map((v) => v - mean);
    const similarity = (x, offset) => {
        let dot = 0;
        let energy = 0;
        for (let j = 0; j < template.length; ++j) {
            dot += x[offset + j] * zeroMean[j];
            energy += x[offset + j] * x[offset + j];
        }
        return energy > 0 ? dot / Math.sqrt(energy) : 0;
    };
    // Cosine similarity against the zero-mean pattern, scaled so an exact
    // copy of the pattern scores 1.
    const perfect = similarity(template, 0);
    let best = -Infinity;
    let bestAt = 0;
    for (let i = 0; i + template.length <= envelope.length; ++i) {
        const score = similarity(envelope, i);
        if (score > best) {
            best = score;
            bestAt = i;
        }
    }
    // The envelope at a window's start describes the signal at its centre.
    return { sample: (first + bestAt) * hop + Math.round(win / 2), quality: best / perfect };
}

const AnalysisWindowFraction = 0.6;
const HarmonicsReported = 3;
const NoiseBands = [
    [100, 500],
    [500, 1000],
    [1000, 2000],
    [2000, 4000],
    [4000, 8000],
    [8000, 16000],
    [16000, 24000],
];

function fftMagnitudes(x) {
    let n = 1;
    while (n * 2 <= x.length) n *= 2;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; ++i) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    for (let i = 1, j = 0; i < n; ++i) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        for (let i = 0; i < n; i += len) {
            for (let k = 0; k < len / 2; ++k) {
                const c = Math.cos(ang * k);
                const s = Math.sin(ang * k);
                const a = i + k;
                const b = a + len / 2;
                const tr = re[b] * c - im[b] * s;
                const ti = re[b] * s + im[b] * c;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
    const mag = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; ++i) mag[i] = Math.hypot(re[i], im[i]) / (n / 4);
    return { mag, n };
}

function bandLevels(x, rate) {
    const { mag, n } = fftMagnitudes(x);
    const binHz = rate / n;
    return NoiseBands.filter(([, hi]) => hi <= rate / 2 + binHz).map(([lo, hi]) => {
        let power = 0;
        for (let i = Math.ceil(lo / binHz); i < Math.min(mag.length, Math.floor(hi / binHz)); ++i) power += mag[i] ** 2;
        return { lo, hi, level: Math.sqrt(power) };
    });
}

function spectralPeaks(x, rate, count) {
    const { mag, n } = fftMagnitudes(x);
    const binHz = rate / n;
    const peaks = [];
    for (let i = 2; i < mag.length - 1; ++i) {
        if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) peaks.push({ hz: i * binHz, level: mag[i] });
    }
    return peaks.sort((a, b) => b.level - a.level).slice(0, count);
}

/** Measures every segment of the schedule in a capture aligned on its markers. */
export function analyseCapture(samples, rate, schedule, { startSeconds = null } = {}) {
    const csToSamples = (cs) => (cs / 100) * rate;
    let start;
    let startQuality = null;
    if (startSeconds !== null) {
        start = Math.round(startSeconds * rate);
    } else {
        // The end marker is the same pattern; only the start has a whole schedule after it.
        const latestStart = samples.length - csToSamples(schedule.totalCs);
        ({ sample: start, quality: startQuality } = findMarker(samples, rate, 0, Math.max(latestStart, 0)));
    }
    const endSegment = schedule.segments.find((s) => s.kind === "marker" && s.label === "end");
    const expectedEnd = start + csToSamples(endSegment.start);
    const slack = csToSamples(200);
    const endMarker = findMarker(samples, rate, expectedEnd - slack, expectedEnd + slack);
    let clockRatio = 1;
    if (endMarker.quality > 0.5) clockRatio = (endMarker.sample - start) / csToSamples(endSegment.start);
    const at = (cs) => Math.round(start + csToSamples(cs) * clockRatio);

    const window = (segment) => {
        const trim = (segment.duration * (1 - AnalysisWindowFraction)) / 2;
        const from = at(segment.start + trim);
        const length = at(segment.start + segment.duration - trim) - from;
        return { from, length };
    };
    const tone = (segment) => {
        const { from, length } = window(segment);
        const hz = toneHz(segment.period);
        const harmonics = [];
        for (let h = 1; h <= HarmonicsReported; ++h) {
            const f = (hz * h) / clockRatio;
            harmonics.push(f < rate / 2 ? goertzelAmplitude(samples, from, length, f, rate) : null);
        }
        if (harmonics[0] === null) return { ...segment, hz, harmonics, aboveNyquist: true };
        return { ...segment, hz, harmonics };
    };
    const results = schedule.segments.map((segment) => {
        if (segment.kind === "marker") {
            const found = findMarker(samples, rate, at(segment.start) - slack, at(segment.start) + slack);
            const burst = csToSamples(MarkerBurstCs);
            const level = goertzelAmplitude(
                samples,
                found.sample + Math.round(burst * 0.2),
                Math.round(burst * 0.6),
                toneHz(MarkerPeriod) / clockRatio,
                rate,
            );
            return { ...segment, sample: found.sample, quality: found.quality, level };
        }
        if (segment.kind === "tone" || segment.kind === "staircase") return tone(segment);
        const { from, length } = window(segment);
        const block = samples.subarray(from, from + length);
        if (segment.kind === "noise") return { ...segment, bands: bandLevels(block, rate), rms: rms(block) };
        return {
            ...segment,
            hz: toneHz(segment.period),
            rms: rms(block),
            peaks: spectralPeaks(block, rate, 5),
            bands: bandLevels(block, rate),
        };
    });
    return { rate, start, startQuality, clockRatio, endMarkerQuality: endMarker.quality, results };
}

function printAnalysis(a, b) {
    const seconds = (s) => (s / a.rate).toFixed(3);
    console.log(`start marker at ${seconds(a.start)} s (match ${a.startQuality?.toFixed(2) ?? "forced"})`);
    console.log(
        `end marker match ${a.endMarkerQuality.toFixed(2)}, clock ratio ${a.clockRatio.toFixed(6)} (${((a.clockRatio - 1) * 1e6).toFixed(0)} ppm)`,
    );
    if (b) {
        console.log(
            `second capture: start at ${(b.start / b.rate).toFixed(3)} s, clock ratio ${b.clockRatio.toFixed(6)}`,
        );
    }
    const pair = a.results.map((r, i) => [r, b?.results[i]]);
    const reference = (analysis) => analysis.results.find((r) => r.kind === "tone" && r.period === ReferencePeriod);
    const refA = reference(a).harmonics[0];
    const refB = b ? reference(b).harmonics[0] : null;
    console.log(
        `\nreference tone (${toneHz(ReferencePeriod).toFixed(0)} Hz, full volume): ${fmtDb(refA)} dBFS${b ? `, second ${fmtDb(refB)} dBFS` : ""}`,
    );
    if (b) console.log("rel: the second capture relative to the first, each normalised to its reference tone.");

    const toneRow = (r, s) => {
        if (r.aboveNyquist)
            return `${String(r.period).padStart(5)}  ${r.hz.toFixed(1).padStart(8)}  above the capture's Nyquist`;
        const cols = [
            String(r.period).padStart(5),
            r.hz.toFixed(1).padStart(8),
            fmtDb(r.harmonics[0]),
            ...r.harmonics.slice(1).map((h) => (h === null ? "     -" : fmtDb(h / r.harmonics[0]))),
        ];
        if (s) cols.push(s.aboveNyquist ? "     -" : fmtDb(s.harmonics[0] / refB / (r.harmonics[0] / refA)));
        return cols.join("  ");
    };
    const toneHeader = `    N        Hz    dBFS    H2    H3${b ? "   rel" : ""}`;
    for (const attenuation of [0, ...QuieterAttenuations]) {
        console.log(`\ntones, attenuation ${attenuation} (${-2 * attenuation} dB)\n${toneHeader}`);
        for (const [r, s] of pair) if (r.kind === "tone" && r.attenuation === attenuation) console.log(toneRow(r, s));
    }
    console.log(
        `\nvolume staircase at ${toneHz(StaircasePeriod).toFixed(0)} Hz\n  att    dBFS   step${b ? "  second   step" : ""}`,
    );
    let previous = null;
    let previousB = null;
    for (const [r, s] of pair) {
        if (r.kind !== "staircase") continue;
        const level = r.harmonics[0];
        const cols = [String(r.attenuation).padStart(5), fmtDb(level), previous ? fmtDb(level / previous) : "      "];
        if (s) cols.push(fmtDb(s.harmonics[0]), previousB ? fmtDb(s.harmonics[0] / previousB) : "");
        console.log(cols.join("  "));
        previous = level;
        previousB = s?.harmonics[0];
    }
    const bandHeader = NoiseBands.map(([lo, hi]) => `${lo / 1000}-${hi / 1000}k`.padStart(9)).join("");
    console.log(`\nnoise, band levels in dBFS\n${"mode".padEnd(22)}      rms${bandHeader}`);
    for (const [r, s] of pair) {
        if (r.kind !== "noise") continue;
        const row = (x) =>
            `${fmtDb(x.rms).padStart(9)}${x.bands.map((band) => fmtDb(band.level).padStart(9)).join("")}`;
        console.log(`${r.label.padEnd(22)}${row(r)}`);
        if (s) console.log(`${"  second".padEnd(22)}${row(s)}`);
    }
    console.log("\nsample-playback carriers (volume ramped 15 to 0 to 15)");
    for (const [r, s] of pair) {
        if (r.kind !== "carrier") continue;
        const describe = (x) =>
            `rms ${fmtDb(x.rms)} dBFS, peaks ${x.peaks.map((p) => `${(p.hz / 1000).toFixed(2)} kHz ${db(p.level).toFixed(1)}`).join(", ")}`;
        console.log(`  period ${r.period} (${(r.hz / 1000).toFixed(2)} kHz): ${describe(r)}`);
        if (s) console.log(`    second: ${describe(s)}`);
    }
}

function parseArgs(argv) {
    const positional = [];
    const options = {};
    for (let i = 0; i < argv.length; ++i) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            positional.push(arg);
            continue;
        }
        const name = arg.slice(2);
        if (name === "unfiltered") options[name] = true;
        else options[name] = argv[++i];
    }
    return { positional, options };
}

async function runReference(outFile, { model = "Master", rate = "48000", unfiltered = false }) {
    const { TestMachine } = await import("../tests/test-machine.js");
    const { SoundChip } = await import("../src/soundchip.js");
    const { PolyphaseResampler } = await import("../src/resampler.js");
    const { LowPassBiquad } = await import("../src/biquad.js");
    const { OutputFilterHz, OutputFilterQ, ResamplerCutoffOfOutputRate, ResamplerTaps } =
        await import("../src/audio-output.js");
    const outputRate = Number(rate);
    const disc = await buildDisc();
    const schedule = buildSchedule();

    let chip;
    let samples = new Float32Array(1 << 20);
    let outputLength = 0;
    let phase = 0;
    let filters = [];
    let resampler = null;
    let ratio = 1;
    const onBuffer = (buffer) => {
        const count = buffer.length;
        resampler.reserve(count);
        resampler.buffer.set(buffer, resampler.inputOffset);
        for (const filter of filters) filter.process(resampler.buffer, resampler.inputOffset, count);
        const produced = Math.max(0, Math.ceil((count - phase) / ratio));
        if (outputLength + produced > samples.length) {
            const grown = new Float32Array(samples.length * 2);
            grown.set(samples);
            samples = grown;
        }
        resampler.read(samples.subarray(outputLength, outputLength + produced), phase, ratio);
        outputLength += produced;
        resampler.commit();
        phase = phase + produced * ratio - count;
    };
    chip = new SoundChip(onBuffer);
    ratio = chip.soundchipFreq / outputRate;
    filters = unfiltered ? [] : [new LowPassBiquad(chip.soundchipFreq, OutputFilterHz, OutputFilterQ)];
    resampler = new PolyphaseResampler(chip.soundchipFreq, ResamplerCutoffOfOutputRate * outputRate, {
        taps: ResamplerTaps,
    });

    const machine = new TestMachine(model, { soundChip: chip });
    await machine.initialise();
    machine.loadDiscData(disc);
    const cyclesPerSecond = machine.model.cyclesPerSecond;
    const ShiftKey = 16;
    machine.processor.sysvia.keyDown(ShiftKey);
    machine.reset(true);
    await machine.runFor(2 * cyclesPerSecond);
    machine.processor.sysvia.keyUp(ShiftKey);
    const runSeconds = schedule.totalCs / 100 + StartDelayCs / 100 + 4;
    for (let s = 0; s < runSeconds; ++s) {
        await machine.runFor(cyclesPerSecond);
        process.stderr.write(`\r${s + 1}/${runSeconds.toFixed(0)} s`);
    }
    chip.catchUp();
    process.stderr.write("\n");
    writeWav(outFile, samples.subarray(0, outputLength), outputRate);
    console.log(
        `wrote ${outFile}: ${(outputLength / outputRate).toFixed(1)} s at ${outputRate} Hz, ${model}${unfiltered ? ", board filter off" : ""}`,
    );
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [command, ...args] = positional;
    const schedule = buildSchedule();
    switch (command) {
        case "build": {
            const out = args[0] ?? "sweep.ssd";
            fs.writeFileSync(out, await buildDisc());
            console.log(`wrote ${out}: ${schedule.events.length} events over ${(schedule.totalCs / 100).toFixed(0)} s`);
            return;
        }
        case "basic":
            process.stdout.write(basicSource(schedule));
            return;
        case "reference":
            if (!args[0]) throw new Error("reference needs an output WAV path");
            await runReference(args[0], options);
            return;
        case "analyse": {
            if (!args[0]) throw new Error("analyse needs a WAV path");
            const analyses = args.slice(0, 2).map((file, i) => {
                const wav = readWav(file);
                const { samples, used } = pickChannel(wav, options.channel ?? "auto");
                console.log(
                    `${file}: ${wav.rate} Hz, ${wav.channels.length} channel(s), using ${used}, ${(samples.length / wav.rate).toFixed(1)} s`,
                );
                const startSeconds = i === 0 && options.start !== undefined ? Number(options.start) : null;
                return analyseCapture(samples, wav.rate, schedule, { startSeconds });
            });
            printAnalysis(analyses[0], analyses[1]);
            if (options.json) fs.writeFileSync(options.json, JSON.stringify(analyses, null, 1));
            return;
        }
        default:
            console.error(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
            process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
