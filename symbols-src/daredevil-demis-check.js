/**
 * Daredevil Demis's moments for tools/symbols/check-memory.js: the title screen, then the shoots in
 * seeded random play.
 */

import { BBC } from "../src/keymap.js";
import { holdUntil, pressKey, runSeconds } from "../tools/symbols/check-memory.js";

const TitleSecs = 3;
const PlayMoments = 8;
const PlayFramesPerMoment = 150;
const PlaySeed = 1;
const PlayMinHoldFrames = 5;
const PlayHoldFrameRange = 40;

const Game = ["game/code"];
const PlayKeys = [BBC.X, BBC.Z, BBC.SPACE];

/** A seeded linear congruential generator, so random play is the same each run. */
function seededRandom(seed) {
    let state = seed;
    return (n) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return Math.floor((state / 0x80000000) * n);
    };
}

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
            let frames = 0;
            while (frames < PlayFramesPerMoment) {
                const key = PlayKeys[random(PlayKeys.length)];
                const hold = PlayMinHoldFrames + random(PlayHoldFrameRange);
                await pressKey(session, key, hold);
                frames += hold;
            }
            check(`random play, moment ${moment}`, Game);
        }
    },
};
