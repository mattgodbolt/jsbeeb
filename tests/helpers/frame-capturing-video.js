import { Video } from "../../src/video.js";

export const FbWidth = 1024;
export const FbHeight = 625;

/**
 * A Video that keeps a copy of each complete frame it paints in `frame`: read straight after a run, `fb32` and
 * `lineGrid` hold only as much of the raster as the beam had reached. Set `frame` to null to wait for the next.
 */
export class FrameCapturingVideo extends Video {
    constructor({ isMaster, isAtom }) {
        super(isMaster, FbWidth * FbHeight, () => {}, { isAtom });
        this.frame = null;
        this.paint_ext = () => {
            this.frame = { fb32: this.fb32.slice(), lineGrid: this.lineGrid.slice() };
        };
    }
}
