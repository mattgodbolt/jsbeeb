/**
 * PIPELINE's moments for tools/symbols/check-memory.js: each scenario boots the disc, goes somewhere in
 * the programs, and says which regions should match there. Regions that match while their program
 * isn't running are leftovers the format expects (the GRAPHIC stub through the Graphics Designer, MRUN
 * in BASIC's line buffer, TITLE's unpacker until IO loads, MENU's BASIC until the game lands on it).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { BBC } from "../src/keymap.js";
import { holdUntil, pressKey, ReleaseFrames, runScript, runSeconds } from "../tools/symbols/check-memory.js";

// MENU's screen comes up this long after the boot, after the loading picture and the warning page.
const MenuSecs = 33;
const StepsPerCheck = 25;
const PlayMoments = 30;
const PlayFramesPerMoment = 200;
const PlaySeed = 1;
const PlayMinHoldFrames = 5;
const PlayHoldFrameRange = 40;
const LevelBytesChecked = 0x100;

const Game = [
    "game/event_handler",
    "game/sound_data",
    "game/low_code",
    "game/main_low",
    "game/main_swapped",
    "game/main_swapped_2",
    "game/main_high",
];
const LevelDesigner = ["level-designer/main", "level-designer/low_code", "level-designer/font", "level-designer/wdata"];
const Menu = ["menu/program", "menu/scroller", "menu/menu_screen"];
const GraphicsDesigner = ["graphic-stub/main", "graphics-designer/main"];

/** From the boot to MENU's option `n`, chosen. */
async function menuOption(session, n) {
    await runSeconds(session, MenuSecs);
    await runScript(session, [`key Digit${n}`, "key Enter"]);
}

/** A seeded linear congruential generator, so random play is the same each run. */
function seededRandom(seed) {
    let state = seed;
    return (n) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return Math.floor((state / 0x80000000) * n);
    };
}

// The Graphics Designer's tours: painting, the OptionsA, OptionsB and Environment menus, and the CTRL
// shortcuts. Its keys: Z X : / move the pixel cursor; the cursor keys pick a sprite; 0-4 pick a colour;
// Return plots, Delete clears; f0-f3 open its four menus (jsbeeb's physical layout puts ':' on the
// apostrophe key and f0 on F10). Keys pressed in quick succession get lost, hence the pauses.
const typed = (text) =>
    [...text].flatMap((c) => {
        if (/[A-Z]/.test(c)) return [`key Key${c} 3`, "wait 0.1"];
        if (/[0-9]/.test(c)) return [`key Digit${c} 3`, "wait 0.1"];
        if (c === ".") return ["key Period 3", "wait 0.1"];
        throw new Error(`Can't type ${c}`);
    });
const MenuKeys = ["F10", "F1", "F2", "F3"];
const menu = (n, item) => [
    `key ${MenuKeys[n]} 5`,
    "wait 0.5",
    ...Array(item - 1)
        .fill(["key ArrowDown 3", "wait 0.2"])
        .flat(),
    "key Enter 5",
    "wait 1",
];
const ctrl = (code) => ["down ControlLeft", `key ${code} 4`, "up ControlLeft", "wait 1"];
const hold = (code, secs) => [`down ${code}`, `wait ${secs}`, `up ${code}`];
const home = [...hold("ArrowUp", 4), ...hold("ArrowLeft", 4)];
const step = (code, n) =>
    Array(n)
        .fill(`key ${code} 8`)
        .flatMap((k) => [k, "wait 0.3"]);
const shot = (tour, name) => `shot ${tour}_${name}`;
const file = (item, name, secs = 5) => [...menu(2, item), ...typed(name), "key Enter 3", `wait ${secs}`];

// prettier-ignore
const Tours = {
    edit: (t) => [
        ...step("KeyX", 2), ...step("Slash", 2),
        "key Digit1 3", "key Enter 3", "key KeyX 3", "key Digit2 3", "key Enter 3",
        "key KeyX 3", "key Digit3 3", "key Enter 3", "key Slash 3", "key Digit0 3", "key Enter 3",
        "key Digit4 3", "key Enter 3", "key Delete 3", "key Quote 3", "key KeyZ 3", "key Delete 3",
        ...hold("KeyX", 3), ...hold("Slash", 4), ...hold("KeyZ", 3), ...hold("Quote", 4),
        ...hold("KeyZ", 1), ...hold("Quote", 1),
        shot(t, "painted"),
        // Walk the whole 5x5 sheet of large sprites, then the small ones.
        ...[0, 1, 2, 3, 4].flatMap(() => [...step("ArrowRight", 5), "key ArrowDown 3", "wait 0.2"]),
        ...step("ArrowLeft", 6), ...step("ArrowUp", 6), ...step("ArrowDown", 9),
        ...[0, 1, 2, 3].flatMap(() => [...step("ArrowRight", 4), "key ArrowDown 3", "wait 0.2"]),
        ...step("ArrowLeft", 5), ...step("ArrowUp", 4),
        shot(t, "small"),
        "key Digit2 3", ...step("KeyX", 3), "key Enter 3", ...hold("KeyX", 2), ...hold("Slash", 3),
        "key Enter 3", "key Digit3 3", ...hold("KeyZ", 2), "key Enter 3",
        ...hold("Quote", 3),
        shot(t, "small_painted"),
        ...hold("ArrowUp", 4), ...hold("ArrowRight", 4), ...hold("ArrowDown", 4), ...hold("ArrowLeft", 4),
        // The background tile (top left) repeats every pixel plotted into it.
        ...home, "key Digit3 3", "key Enter 3", ...step("KeyX", 3), "key Enter 3",
        shot(t, "background"),
    ],
    optionsA: (t) => [
        "key ArrowRight 3", "wait 0.3", "key ArrowDown 3", "wait 0.3",
        ...menu(0, 1), shot(t, "flipx"), ...menu(0, 2), shot(t, "flipy"),
        ...menu(0, 4), shot(t, "undo"), ...menu(0, 3), shot(t, "delete"), ...menu(0, 4), shot(t, "undone"),
        // Animate only does anything on the two-frame pairs: sheet positions 9
        // and 14 (right column, rows 1 and 2) and 37-40 (bottom row, columns 1-4).
        ...menu(0, 5), shot(t, "animate_none"),
        ...home, ...step("ArrowRight", 4), ...step("ArrowDown", 1),
        ...menu(0, 5), "wait 1", shot(t, "animate1"), "wait 0.3", shot(t, "animate2"), "key Space 3", "wait 1",
        ...step("ArrowDown", 1), ...menu(0, 5), "wait 2", "key Escape 3", "wait 1", "key Enter 3", "wait 1",
        ...home, ...step("ArrowDown", 4), ...step("ArrowRight", 1),
        ...[0, 1, 2, 3].flatMap(() => [...menu(0, 5), "wait 2", "key Space 3", "wait 1", ...step("ArrowRight", 1)]),
        // Small sprites (below the sheet): names, and the operations at half size.
        ...home, ...hold("ArrowDown", 4), ...step("ArrowRight", 1),
        ...menu(0, 6), shot(t, "name"), ...typed("BOMB"), "key Delete 3", "wait 0.1", "key KeyX 3", "wait 0.1",
        "key Enter 3", "wait 1", shot(t, "named"),
        ...menu(0, 6), "key Escape 3", "wait 1", "key Enter 3", "wait 1",
        ...menu(0, 6), ...typed("ABCDEFGHIJKLMN"), "key Enter 3", "wait 1",
        ...menu(0, 1), ...menu(0, 2), ...menu(0, 3), ...menu(0, 4), ...menu(0, 5), "wait 1", "key Space 3",
        // The last small sprite (the exit's icon) has no name.
        ...hold("ArrowRight", 4), ...hold("ArrowDown", 4), ...menu(0, 6), shot(t, "man"),
        ...menu(0, 3), ...menu(0, 4),
        // Leave a menu by Space, by another menu's key, and step over its ends.
        "key F10 5", "wait 0.5", "key ArrowUp 3", "wait 0.3", ...step("ArrowDown", 8), ...step("ArrowUp", 2), "key Space 3", "wait 0.5",
        "key F10 5", "wait 0.5", "key F1 3", "wait 0.5", "key F10 5", "wait 0.5", "key Escape 3", "wait 1",
        "key Enter 3", "wait 1",
    ],
    optionsB: (t) => [
        "key ArrowRight 3", "wait 0.3", "key ArrowDown 3", "wait 0.3",
        ...menu(1, 1), shot(t, "swap"), "key ArrowRight 3", "wait 0.5", "key Enter 3", "wait 1",
        ...menu(1, 2), shot(t, "copy"), "key ArrowDown 3", "wait 0.5", "key Enter 3", "wait 1",
        ...menu(1, 3), "key ArrowLeft 3", "wait 0.5", "key Enter 3", "wait 1", shot(t, "overlay"),
        ...menu(1, 4), "key ArrowUp 3", "wait 0.5", "key Enter 3", "wait 1", shot(t, "underlay"),
        ...menu(1, 5), "key ArrowRight 3", "wait 0.5", "key Enter 3", "wait 1", shot(t, "remove"),
        ...menu(1, 6), "key ArrowRight 3", "wait 0.5", "key Enter 3", "wait 1", shot(t, "backing"),
        ...menu(1, 1), "key Space 3", "wait 1", ...menu(1, 2), "key Escape 3", "wait 1", "key Enter 3", "wait 1",
        // Large onto small and back, which it refuses or scales.
        ...menu(1, 2), ...hold("ArrowDown", 4), "key Enter 3", "wait 1", shot(t, "copy_small"),
        ...menu(1, 1), ...hold("ArrowUp", 4), "key Enter 3", "wait 1",
        ...menu(1, 3), "key ArrowRight 3", "key Enter 3", "wait 1",
        ...menu(1, 4), "key ArrowRight 3", "key Enter 3", "wait 1",
        ...menu(1, 5), "key ArrowRight 3", "key Enter 3", "wait 1",
        ...menu(1, 6), "key ArrowRight 3", "key Enter 3", "wait 1",
        ...menu(0, 4), "wait 1",
    ],
    files: (t) => [
        "key ArrowRight 3", "wait 0.3",
        ...file(4, "GFX1", 8), shot(t, "savefile"),
        ...file(4, "GFX1", 3), shot(t, "exists"), "key Enter 3", "wait 1",
        ...file(4, "GFX1", 3), "key ArrowDown 3", "wait 0.2", "key Enter 3", "wait 8",
        ...menu(0, 3),
        // Saving a sprite writes it into a graphics file that's already there.
        ...file(2, "GFX1", 2), shot(t, "savesprite"), "key ArrowDown 3", "wait 0.3", "key Enter 3", "wait 5",
        ...menu(0, 3), ...file(1, "GFX1", 5), shot(t, "loadsprite"),
        ...hold("ArrowDown", 4), ...file(2, "GFX1", 2), "key ArrowDown 3", "wait 0.3", "key Enter 3", "wait 5",
        ...menu(0, 3), ...file(1, "GFX1", 5),
        ...file(2, "GFX1", 2), "key Enter 3", "wait 1",
        ...file(2, "NEW", 5),
        ...file(1, "NOSUCH", 4), shot(t, "nosuch"), "key Space 3", "wait 1",
        ...file(1, "MENU", 4), shot(t, "wrongtype"), "key Space 3", "wait 1",
        ...file(3, "MENU", 4), "key Space 3", "wait 1",
        ...file(3, "NOSUCH", 4), "key Space 3", "wait 1",
        ...file(3, "DEFAULT", 8), shot(t, "loaddefault"),
        ...file(3, "IO", 8), shot(t, "loadio"),
        ...file(1, "IO", 5), ...file(2, "IO", 2), "key ArrowDown 3", "wait 0.3", "key Enter 3", "wait 5",
        ...hold("ArrowUp", 4), ...file(1, "IO", 5), ...file(2, "IO", 2), "key ArrowDown 3", "wait 0.3", "key Enter 3", "wait 5",
        ...menu(2, 2), "key Delete 3", "key Enter 3", "wait 2", "key Space 3", "wait 1",
        ...menu(2, 2), "key Escape 3", "wait 1", "key Enter 3", "wait 1",
        ...file(4, "IO", 8), "key ArrowDown 3", "wait 0.2", "key Enter 3", "wait 8",
        ...file(3, "GFX1", 8), shot(t, "loadfile"),
        ...menu(2, 5), shot(t, "colour"), "key Enter 3", "wait 1",
        ...menu(2, 5), "key ArrowDown 3", "wait 0.2", "key Enter 3", "wait 1",
        ...menu(2, 5), "key ArrowDown 3", "wait 0.2", "key ArrowDown 3", "wait 0.2", "key Enter 3", "wait 1",
        ...menu(2, 5), "key ArrowDown 3", "wait 0.2", "key ArrowDown 3", "wait 0.2", "key ArrowDown 3", "wait 0.2", "key Enter 3", "wait 1",
        ...menu(2, 5), "key Space 3", "wait 1",
        "key F3 5", "wait 1", shot(t, "credits"), "key Space 3", "wait 1",
        "key F3 5", "wait 1", "key Enter 3", "wait 1", "key F3 5", "wait 1", "key F2 5", "wait 1", "key Space 3",
    ],
    shortcuts: (t) => [
        "key ArrowRight 3", "wait 0.3", "key ArrowDown 3", "wait 0.3",
        ...ctrl("KeyX"), ...ctrl("KeyY"), ...ctrl("KeyU"), ...ctrl("Delete"), ...ctrl("KeyU"),
        ...ctrl("KeyA"), "key Space 3", ...ctrl("KeyS"), "key ArrowRight 3", "key Enter 3", "wait 1",
        ...ctrl("End"), "key ArrowRight 3", "key Enter 3", "wait 1",
        ...ctrl("KeyO"), "key ArrowLeft 3", "key Enter 3", "wait 1",
        ...ctrl("KeyR"), "key ArrowLeft 3", "key Enter 3", "wait 1",
        ...ctrl("KeyB"), "key ArrowLeft 3", "key Enter 3", "wait 1",
        ...ctrl("KeyC"), shot(t, "colour"), "key ArrowDown 3", "wait 0.2", "key Enter 3", "wait 1",
        ...ctrl("F8"), shot(t, "f8"), "key Space 3", "wait 1",
        ...ctrl("F9"), shot(t, "f9"), "key Space 3", "wait 1",
        ...ctrl("F6"), shot(t, "f6"), "key Space 3", "wait 1",
        ...ctrl("F7"), shot(t, "f7"), "key Space 3", "wait 1",
        ...hold("ArrowDown", 4), ...ctrl("KeyN"), "key Space 3", "wait 1",
        // Holding CTRL steps the pixel cursor without the sprite selection.
        "down ControlLeft", ...hold("KeyX", 1), ...hold("Slash", 1), "up ControlLeft",
    ],
};

export const scenarios = {
    async menu({ session, address, check }) {
        const vsync = address("menu", "scroller", "scroller.vsync_handler");
        await runSeconds(session, MenuSecs);
        for (const [moment, secs] of [
            ["the menu", 3],
            ["3 s later", 7],
            ["10 s later", 0],
        ]) {
            await session.runUntilAddress(vsync);
            check(`${moment}, in the scroller's vsync handler`, Menu);
            await runSeconds(session, secs);
        }
        await pressKey(session, BBC.K2);
        await runSeconds(session, 2);
        check("redefining the keys", Menu);
    },

    async title({ session, address, check }) {
        await menuOption(session, 1);
        // MENU's MODE 1 has cleared the screen and the end of the scroller with it.
        await session.runUntilAddress(address("title", "title", "start"));
        check("TITLE entered, before it moves", ["menu/program", "title/title"]);
        await session.runUntilAddress(address("title", "unpack", "unpack"));
        check("TITLE's unpacker, moved", ["menu/program", "title/title", "title/unpack"]);
        await session.runUntilAddress(address("title", "unpack", "clear_bottom"));
        check("TITLE's unpacker, the picture unpacked", ["menu/program", "title/unpack"]);
    },

    async game({ session, address, check }) {
        await menuOption(session, 1);
        await session.runUntilAddress(address("game", "loader", "loader"));
        check("H.GAME's loader entered", ["game-stub/main", "game/loader", "menu/program", "title/unpack"]);
        await session.runUntilAddress(address("game", "game_start", "game_start"));
        check("game_start", [...Game, "game/game_start", "game/loader", "title/unpack"]);
        // load_mission has swapped SWAP_START to SWAP_END into the screen.
        await session.runUntilAddress(address("game", "main_high", "load_mission_block"));
        const swapped = ["game/main_swapped", "game/main_swapped_2"];
        check("loading IO, part of the game swapped out", [
            ...Game.filter((r) => !swapped.includes(r)),
            "game/loader",
            "title/unpack",
        ]);
        await session.runUntilAddress(address("game", "main_swapped_2", "title_screen"));
        check("the title screen", [...Game, "game/game_start"]);
        await runSeconds(session, 1);
        await pressKey(session, BBC.SPACE);
        const loop = address("game", "main_swapped_2", "game_loop");
        await session.runUntilAddress(loop);
        check("in play: game_loop, the level just set up", Game);
        const moves = [BBC.Z, BBC.X, BBC.COLON_STAR, BBC.SLASH];
        for (let i = 0; i < 12; i++) {
            await pressKey(session, moves[i % moves.length], 20);
            if (i % 4 === 3) {
                await session.runUntilAddress(loop);
                check(`in play: game_loop after ${i + 1} moves`, Game);
            }
        }
        await session.runUntilAddress(address("game", "event_handler", "event_handler"));
        check("in play: the tune's event handler", Game);
    },

    // Walking, pushing, picking up, dropping and throwing, the map and the backpack, with a check every
    // few seconds wherever the PC is.
    async play({ session, address, check }) {
        await menuOption(session, 1);
        await session.runUntilAddress(address("game", "main_swapped_2", "title_screen"));
        await runSeconds(session, 1);
        await holdUntil(session, BBC.SPACE, address("game", "main_swapped_2", "game_loop"));
        const keys = [BBC.Z, BBC.X, BBC.COLON_STAR, BBC.SLASH, BBC.P, BBC.D, BBC.T, BBC.RETURN, BBC.M, BBC.CTRL];
        const random = seededRandom(PlaySeed);
        for (let moment = 1; moment <= PlayMoments; moment++) {
            for (let frames = 0; frames < PlayFramesPerMoment;) {
                const key = keys[random(keys.length)];
                const held = PlayMinHoldFrames + random(PlayHoldFrameRange);
                await pressKey(session, key, held);
                frames += held + ReleaseFrames;
            }
            check(`random play, moment ${moment}`, Game);
        }
    },

    async levdes({ session, sets, filesDir, address, check }) {
        await menuOption(session, 4);
        await session.runUntilAddress(address("level-designer", "startup", "entry"));
        // MENU's screen data is still above it, until MODE 1.
        check("the Level Designer's entry", [
            "level-designer/main",
            "level-designer/startup",
            "levdes-stub/main",
            "menu/menu_screen",
        ]);
        await runSeconds(session, 15);
        check("its title, waiting for Space", ["level-designer/startup", ...LevelDesigner]);
        const loop = address("level-designer", "main", "main_loop");
        await holdUntil(session, BBC.SPACE, loop);
        check("main_loop, a new level", LevelDesigner);
        // Files, Load level, LEVEL1 with its editing code. main_loop comes round again once get_key
        // returns a key it doesn't act on itself, such as a digit choosing the brush.
        await runScript(session, ["key F2", "wait 1", "key Enter", "wait 1", "key KeyY", "wait 1"]);
        await runScript(session, ["type LEVEL1", "wait 1", "type 677636", "wait 4"]);
        const level = [...sets["level-designer"].globals].find(([, name]) => name === "level_names")[0];
        const levelFile = readFileSync(path.join(filesDir, "LEVEL1")).subarray(0, LevelBytesChecked);
        if (!Buffer.from(session.readMemory(level, LevelBytesChecked)).equals(levelFile))
            throw new Error("LEVEL1 didn't load");
        check("waiting for a key, LEVEL1 loaded", LevelDesigner);
        await holdUntil(session, BBC.K1, loop);
        check("main_loop, LEVEL1 loaded, brush 1", LevelDesigner);
        for (const key of [BBC.X, BBC.SLASH, BBC.RETURN, BBC.Z, BBC.DELETE]) await pressKey(session, key, 10);
        await runSeconds(session, 1);
        check("after plotting and deleting", LevelDesigner);
        await holdUntil(session, BBC.K2, loop);
        check("main_loop, brush 2", LevelDesigner);
        await holdUntil(session, BBC.F1, address("level-designer", "low_code", "window_menu"));
        check("the Options menu open", LevelDesigner);
        // Into its first item (Start/Finish) and out, then the simulator, Help and About.
        await runScript(session, ["wait 1", "key Enter", "wait 1", "key Space", "wait 1", "key Space", "wait 1"]);
        check("an Options window and out", LevelDesigner);
        await runScript(session, [
            "key KeyS",
            "wait 1",
            "key KeyX 20",
            "key Slash 20",
            "key KeyZ 20",
            "key Quote 20",
            "wait 1",
        ]);
        check("the simulator on, walking", LevelDesigner);
        await runScript(session, ["key KeyS", "wait 1", "key F3", "wait 1"]);
        check("Help", LevelDesigner);
        await runScript(session, ["key Space", "wait 1", "key F4", "wait 1"]);
        check("About", LevelDesigner);
    },

    async graphic({ session, address, check }) {
        await menuOption(session, 3);
        await session.runUntilAddress(address("graphics-designer", "main", "start"));
        check("the Graphics Designer's start", GraphicsDesigner);
        const loop = address("graphics-designer", "main", "main_loop");
        await session.runUntilAddress(loop);
        // The stub stays where it was.
        check("main_loop, DEFAULT loaded", GraphicsDesigner);
        for (const key of [BBC.RIGHT, BBC.DOWN, BBC.X, BBC.X, BBC.RETURN, BBC.K1]) await pressKey(session, key, 10);
        await holdUntil(session, BBC.RETURN, loop);
        check("main_loop, after moving and painting", GraphicsDesigner);
    },

    ...Object.fromEntries(
        Object.entries(Tours).map(([tour, stepsOf]) => [
            `tour-${tour}`,
            async ({ session, address, check, shots }) => {
                const steps = stepsOf(tour);
                await menuOption(session, 3);
                await session.runUntilAddress(address("graphics-designer", "main", "start"));
                await runSeconds(session, 12);
                for (let i = 0; i < steps.length; i += StepsPerCheck) {
                    await runScript(session, steps.slice(i, i + StepsPerCheck), { shots });
                    check(
                        `${tour} tour, step ${Math.min(i + StepsPerCheck, steps.length)} of ${steps.length}`,
                        GraphicsDesigner,
                    );
                }
            },
        ]),
    ),

    async mrun({ session, address, check }) {
        await menuOption(session, 3);
        await session.runUntilAddress(address("graphics-designer", "main", "main_loop"));
        // Escape, then Yes (the second item), then Space for the disc.
        await runScript(session, [
            "wait 1",
            "key Escape 3",
            "wait 1",
            "key ArrowDown 3",
            "wait 0.2",
            "key Enter 3",
            "wait 2",
        ]);
        await holdUntil(session, BBC.SPACE, address("mrun", "main", "start"));
        check("MRUN, leaving the Graphics Designer", [...GraphicsDesigner, "mrun/main"]);
        await runSeconds(session, MenuSecs + 5);
        await session.runUntilAddress(address("menu", "scroller", "scroller.vsync_handler"));
        // MRUN is in BASIC's line buffer, which MENU hasn't needed yet.
        check("the menu again", [...Menu, "graphic-stub/main", "mrun/main"]);
    },

    async pl({ session, address, check }) {
        // W and T held as MENU starts run PL.
        session.keyDownRaw(BBC.W);
        session.keyDownRaw(BBC.T);
        await session.runUntilAddress(address("pl", "decryptor", "pl"), MenuSecs);
        session.keyUpRaw(BBC.W);
        session.keyUpRaw(BBC.T);
        check("PL entered, encrypted", [...Menu, "pl/decryptor", "pl/encrypted"]);
        await session.runUntilAddress(address("pl", "cheat", "pl_cheat.start"));
        check("PL decrypted", [...Menu, "pl/decryptor", "pl/cheat"]);
    },
};
