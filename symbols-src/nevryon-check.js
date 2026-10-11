/**
 * Nevryon's moments for tools/symbols/check-memory.js: through the intro and the options to the loader's
 * menu, where the game's files aren't loaded yet, then into the game's own title screen and on into play.
 */

import { BBC } from "../src/keymap.js";
import { holdUntil, pressKey, pressRandomKeys, runSeconds, seededRandom } from "../tools/symbols/check-memory.js";

// The boot shows the intro until SPACE, then the options until SPACE, then the menu until RETURN.
const IntroSecs = 60;
const OptionsSecs = 30;
const MenuSecs = 30;
const TitleSecs = 5;
const PlayMoments = 8;
const PlayFramesPerMoment = 150;
const PlaySeed = 1;

const Game = ["game/code", "game/code2", "game/code3", "game/graphix"];
const PlayKeys = [BBC.X, BBC.Z, BBC.COLON_STAR, BBC.SLASH, BBC.RETURN];

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
            await pressRandomKeys(session, random, PlayKeys, PlayFramesPerMoment);
            check(`random play, moment ${moment}`, Game);
        }
    },
};
