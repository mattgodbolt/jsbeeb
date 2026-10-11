/**
 * Nevryon's moments for tools/symbols/check-memory.js: through the intro and the options to the loader's
 * menu, where the game's files aren't loaded yet, then into the game's own title screen and on into play.
 */

import { BBC } from "../src/keymap.js";
import { holdUntil, pressKey, runSeconds } from "../tools/symbols/check-memory.js";

// The boot shows the intro until SPACE, then the options until SPACE, then the menu until RETURN.
const IntroSecs = 60;
const OptionsSecs = 30;
const MenuSecs = 30;
const TitleSecs = 5;
const PlayMoments = 8;
const PlayFramesPerMoment = 150;
const PlaySeed = 1;
const PlayMinHoldFrames = 5;
const PlayHoldFrameRange = 40;

const Game = ["game/code", "game/code2", "game/code3", "game/graphix"];
const PlayKeys = [BBC.X, BBC.Z, BBC.COLON_STAR, BBC.SLASH, BBC.RETURN];

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
        await runSeconds(session, IntroSecs);
        await pressKey(session, BBC.SPACE, 5);
        await runSeconds(session, OptionsSecs);
        await pressKey(session, BBC.SPACE, 5);
        await runSeconds(session, MenuSecs);
        check("the loader's menu", []);
        await pressKey(session, BBC.RETURN, 5);
        await session.runUntilAddress(address("game", "code", "main_init"), MenuSecs);
        check("the game starting", Game);
        await runSeconds(session, TitleSecs);
        check("the game's title screen", Game);
        await holdUntil(session, BBC.SPACE, address("game", "code", "main_loop"));
        check("the main loop", Game);
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
