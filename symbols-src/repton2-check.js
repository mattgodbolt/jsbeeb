/**
 * Repton 2's moments for tools/symbols/check-memory.js: each scenario boots the disc, goes somewhere in
 * the game, and says which regions should match there.
 */

import { BBC } from "../src/keymap.js";
import { holdUntil, pressKey, pressRandomKeys, runSeconds, seededRandom } from "../tools/symbols/check-memory.js";

// The loader is still unpacking D.REPB this long after the boot.
const LoadingSecs = 5;
const PlayMoments = 30;
const PlayFramesPerMoment = 200;
const PlaySeed = 1;

const Game = ["game/main", "game/music", "game/page8"];
const Moves = [BBC.Z, BBC.X, BBC.COLON_STAR, BBC.SLASH];

export const scenarios = {
    async game({ session, address, check }) {
        await runSeconds(session, LoadingSecs);
        check("loading", []);
        await session.runUntilAddress(address("game", "page8", "start1"));
        check("start1, the game just in place", Game);
        const status = address("game", "main", "status_screen");
        await session.runUntilAddress(status);
        check("the status screen", Game);
        await runSeconds(session, 1);
        await holdUntil(session, BBC.SPACE, address("game", "main", "repton_postmove"));
        check("in play: after Repton's first move", Game);
        for (const key of Moves) await pressKey(session, key, 20);
        check("in play: after four moves", Game);
        await holdUntil(session, BBC.ESCAPE, address("game", "main", "end_of_game_screen"));
        check("the end of the game", Game);
        await runSeconds(session, 2);
        await holdUntil(session, BBC.SPACE, status);
        check("the status screen again", Game);
    },

    async play({ session, address, check }) {
        await session.runUntilAddress(address("game", "main", "status_screen"));
        await runSeconds(session, 1);
        await holdUntil(session, BBC.SPACE, address("game", "main", "repton_postmove"));
        const random = seededRandom(PlaySeed);
        for (let moment = 1; moment <= PlayMoments; moment++) {
            await pressRandomKeys(session, Moves, random, PlayFramesPerMoment);
            check(`random play, moment ${moment}`, Game);
        }
    },
};
