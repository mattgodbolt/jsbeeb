/**
 * Scorched Earth's moments for tools/symbols/check-memory.js: INTRO, SCORCH's loader copying the game
 * down, the start-up code, the setup screen, a human's turn and a computer's, and a whole game of
 * computers to its scores, shop and next round. The start-up code stays in skyrow and dirtrow until
 * the first round's make_colours fills them.
 */

import { BBC } from "../src/keymap.js";
import { holdUntil, pressKey, runScript, runSeconds } from "../tools/symbols/check-memory.js";

// INTRO's title is up and waiting for a key this long after the boot.
const IntroSecs = 5;
const ComputerRounds = 2;
const DefaultRounds = 10;
// Two computers can take up to MAX_TURNS turns over a round, which the game then calls a draw.
const RoundSecs = 600;

const Game = ["game/code", "game/low_nmi", "game/low_printer", "game/low_stack", "game/low_tape", "game/low_udg"];

/** From the boot, past INTRO, to the setup screen waiting for a key. */
async function toSetup(session, address) {
    await runSeconds(session, IntroSecs);
    await pressKey(session, BBC.SPACE);
    await session.runUntilAddress(address("game", "code", "get_key"));
}

export const scenarios = {
    async intro({ session, check }) {
        await runSeconds(session, IntroSecs);
        check("INTRO's title", []);
        await pressKey(session, BBC.I);
        await runSeconds(session, 2);
        check("INTRO's instructions", []);
    },

    async start({ session, address, check }) {
        await runSeconds(session, IntroSecs);
        await pressKey(session, BBC.SPACE);
        await session.runUntilAddress(address("game", "loader", "loader"));
        check("SCORCH's loader entered", ["game/loader"]);
        await session.runUntilAddress(address("game", "startup", "boot"));
        check("boot, the game copied down", ["game/loader", "game/code", "game/startup"]);
        await session.runUntilAddress(address("game", "code", "main"));
        check("main, the low tables in place and the screen cleared", [...Game, "game/startup"]);
        await session.runUntilAddress(address("game", "code", "get_key"));
        check("the setup screen", [...Game, "game/startup"]);
    },

    async turns({ session, address, check }) {
        await toSetup(session, address);
        const aim = address("game", "code", "aim");
        await holdUntil(session, BBC.SPACE, aim);
        check("player 1 aiming, the first round drawn", Game);
        await holdUntil(session, BBC.SPACE, address("game", "code", "fire"));
        await session.runUntilAddress(address("game", "code", "between_turns"));
        check("after player 1's shot", Game);
        await session.runUntilAddress(address("game", "code", "ai_turn"));
        check("the computer's turn", Game);
        await session.runUntilAddress(aim);
        check("player 1 aiming again, after the computer's shot", Game);
    },

    // Player 1 a computer too (HUMAN wraps round to UNKNOWN), over two rounds.
    async computers({ session, address, check, shots }) {
        await toSetup(session, address);
        await pressKey(session, BBC.DOWN);
        for (let rounds = DefaultRounds; rounds > ComputerRounds; rounds--) await pressKey(session, BBC.LEFT);
        await pressKey(session, BBC.DOWN);
        await pressKey(session, BBC.DOWN);
        await pressKey(session, BBC.LEFT);
        await runScript(session, ["shot computers_setup"], { shots });
        await holdUntil(session, BBC.SPACE, address("game", "code", "new_round"));
        await session.runUntilAddress(address("game", "code", "explosion"));
        check("the first explosion", Game);
        await session.runUntilAddress(address("game", "code", "scores"), RoundSecs);
        check("the first round's scores", Game);
        await holdUntil(session, BBC.SPACE, address("game", "code", "shop"));
        check("the shop", Game);
        await holdUntil(session, BBC.SPACE, address("game", "code", "new_round"));
        check("the second round", Game);
        await session.runUntilAddress(address("game", "code", "scores"), RoundSecs);
        check("the last round's scores", Game);
        await holdUntil(session, BBC.SPACE, address("game", "code", "champion"));
        await runSeconds(session, 2);
        await runScript(session, ["shot computers_champion"], { shots });
        check("the champion", Game);
    },
};
