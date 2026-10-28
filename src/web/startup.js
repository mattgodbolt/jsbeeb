import { BuiltInImages } from "./media-loader.js";
import { RunMode } from "./emulation-loop.js";
import { bootModeOf, parseMediaParams, processAutobootParams } from "../url-params.js";

/**
 * What the URL asks the page to start with.
 * @returns {{media: object, autoboot: string, autoType: string, bootMode: string, mayNeedAnotherModel: boolean,
 *   patch: string|undefined}} `media` is what `Machine.start` loads; the rest is for `startAsTheUrlAsks`
 */
export function startupPlan(parsedQuery) {
    const { needsAutoboot, autoType } = processAutobootParams(parsedQuery);
    const { discImage, secondDiscImage, mmcImage } = parseMediaParams(parsedQuery);
    const { loadBasic, embedBasic, tape, model, patch } = parsedQuery;
    // A BASIC program in the URL is the boot, which basicNeedsRun says whether to run.
    const autoboot = loadBasic ? "" : needsAutoboot;
    return {
        media: {
            discImage: discImage || BuiltInImages[0].file,
            discImageInUrl: !!discImage,
            secondDiscImage: secondDiscImage || null,
            tape,
            mmcImage,
            loadBasic,
            embedBasic,
            basicNeedsRun: loadBasic !== undefined && needsAutoboot === "run",
        },
        autoboot,
        autoType,
        bootMode: bootModeOf(parsedQuery),
        mayNeedAnotherModel: autoboot === "boot" && !model,
        patch,
    };
}

/**
 * Takes the started machine where the URL asked, unless its boot disc needs another machine first.
 * @param {ReturnType<typeof startupPlan>} plan
 * @param {object} deps
 * @param {Promise<object|null>|null} deps.bootDisc the description of the boot disc, when `plan.mayNeedAnotherModel`
 * @param {(details: {boot_mode: string, renderer: string}) => void} deps.noteStart
 * @returns {Promise<boolean>} false when the page is reloading as the machine its boot disc needs
 */
export async function startAsTheUrlAsks(
    plan,
    { bootDisc, machineSwitch, drive0, renderer, noteStart, autoBoot, dbgr, snapshots, loop },
) {
    const disc = await bootDisc;
    if (
        disc &&
        !machineSwitch.satisfies(disc) &&
        (await machineSwitch.switchFor(disc, drive0, { boot: true, replace: true }))
    )
        return false;
    noteStart({ boot_mode: plan.bootMode, renderer });

    switch (plan.autoboot) {
        case "boot":
            autoBoot.boot();
            break;
        case "type":
            autoBoot.type(plan.autoType);
            break;
        case "chain":
            autoBoot.chainTape();
            break;
        case "run":
            autoBoot.runTape();
            break;
        default:
            break;
    }

    if (plan.patch) dbgr.setPatch(plan.patch);

    await snapshots.restorePendingState();

    if (loop.mode !== RunMode.debugging) loop.go();
    return true;
}

/** Wraps hosting a session so a machine paused when the host asked runs once the session has started. */
export const hostAndRun = (loop, host) => async (name) => {
    const session = await host(name);
    if (session) loop.go();
    return session;
};
