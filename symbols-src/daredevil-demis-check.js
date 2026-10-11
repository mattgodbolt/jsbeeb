/**
 * Daredevil Demis's moments for tools/symbols/check-memory.js: the title screen, then the shoots in
 * seeded random play.
 */

import { BBC } from "../src/keymap.js";
import { holdUntil, pressRandomKeys, runSeconds, seededRandom } from "../tools/symbols/check-memory.js";

const TitleSecs = 3;
const PlayMoments = 8;
const PlayFramesPerMoment = 150;
const PlaySeed = 1;

const Game = ["game/code"];
const PlayKeys = [BBC.X, BBC.Z, BBC.SPACE];

export const scenarios = {
    async play({ session, address, check }) {
        await session.runUntilAddress(address("game", "code", "title_screen"));
        check("the title screen starting", Game);
        await runSeconds(session, TitleSecs);
        check("the title screen", Game);
        await holdUntil(session, BBC.SPACE, address("game", "code", "play_shoot"));
        check("a shoot starting", Game);
        const random = seededRandom(PlaySeed);
        for (let moment = 1; moment <= PlayMoments; moment++) {
            await pressRandomKeys(session, PlayKeys, random, PlayFramesPerMoment);
            check(`random play, moment ${moment}`, Game);
        }
    },
};
