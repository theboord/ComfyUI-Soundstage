// The synced review's timing, with no DOM: one master frame drives up to four tiles (clay, colour clay, Draft, Final)
// that may differ in frame rate and length. Everything here is pure, so tests/js/syncreview.test.mjs can check it.
//
// Two ways to line files up (the "Map" control):
//   "frame": frame N of every file is shown together. Right for renders of the same shot (the generators keep the frame
//            count; a 25 fps re-encode of a 24 fps clay still has the same 121 frames).
//   "time":  the same second of every file. Right when the files really are different rates of the same take.
// A tile shorter than the master holds its last frame (the tile says "held").

export const SPEEDS = [0.25, 0.5, 0.75, 1];

/** Seek target for a frame: the middle of the frame, so a decoder never lands on the frame before. */
export const frameTime = (frame, fps) => (Math.max(0, frame) + 0.5) / fps;
/** The frame shown at time t (a presented frame's mediaTime is its start, so a tiny epsilon absorbs float error). */
export const timeFrame = (t, fps) => Math.max(0, Math.floor(t * fps + 1e-3));

/**
 * The tile's own frame for a master frame.
 * @param {number} master  master frame index (0-based)
 * @param {{ masterFps:number, fps:number, frames:number, map?:"frame"|"time" }} o
 * @returns {{ frame:number, held:boolean }}
 */
export function tileFrame(master, { masterFps, fps, frames, map = "frame" }) {
  const m = Math.max(0, Math.floor(master));
  let f = map === "time" && fps > 0 && masterFps > 0 ? timeFrame(m / masterFps, fps) : m;
  const last = Math.max(0, (frames | 0) - 1);
  const held = f > last;
  if (held) f = last;
  return { frame: f, held };
}

/** The tile video's playbackRate: in "frame" mode a 25 fps file shown on a 24 fps master plays at 24/25. */
export const tileRate = (speed, masterFps, fps, map = "frame") =>
  map === "frame" && fps > 0 && masterFps > 0 ? (speed * fps) / masterFps : speed;

/** The master's length in its own frames: the longest tile. */
export function masterLength(tiles, masterFps, map = "frame") {
  let n = 0;
  for (const t of tiles) {
    if (!t || !(t.frames > 0)) continue;
    const len = map === "time" && t.fps > 0 ? Math.round((t.frames / t.fps) * masterFps) : t.frames;
    n = Math.max(n, len);
  }
  return n;
}

/**
 * Drift check for one playing tile. presented: the frame on screen (requestVideoFrameCallback's mediaTime, else
 * currentTime); target: where the master says it should be. More than `tolerance` frames out (default 1) is a seek;
 * one frame of lag is normal display latency and is left alone. Wrap-around at a loop point counts as far out.
 */
export function driftAction(presented, target, tolerance = 1) {
  const d = presented - target;
  return { drift: d, seek: Math.abs(d) > tolerance };
}

/**
 * The master clock: wall time (performance.now) to master frame, with speed, loop in/out and a hold while a tile
 * buffers. It has no timer of its own: the player asks it for the frame on each animation frame, and only while
 * playing, so nothing runs while paused.
 */
export class MasterClock {
  constructor({ fps = 24, length = 1, now = () => performance.now() } = {}) {
    this.fps = fps; this.length = Math.max(1, length); this.now = now;
    this.speed = 1; this.playing = false; this.held = false;
    this.inF = 0; this.outF = this.length - 1; this.loop = true; this.ranged = false;
    this.f0 = 0; this.t0 = 0; this.frame = 0;
  }
  setLength(n) {
    this.length = Math.max(1, n | 0);
    // No In / Out set: the loop is the whole length, however it changes (a file that loads late makes it longer).
    if (!this.ranged || this.outF >= this.length) this.outF = this.length - 1;
    if (this.inF > this.outF) this.inF = 0;
    this.frame = Math.min(this.frame, this.length - 1);
  }
  setRange(inF, outF) {
    const last = this.length - 1;
    const a = Math.max(0, Math.min(last, Math.round(inF))), b = Math.max(0, Math.min(last, Math.round(outF)));
    [this.inF, this.outF] = a <= b ? [a, b] : [b, a];
    this.ranged = this.inF > 0 || this.outF < last;
  }
  clearRange() { this.inF = 0; this.outF = this.length - 1; this.ranged = false; }
  _exact(t = this.now()) { return this.playing && !this.held ? this.f0 + ((t - this.t0) / 1000) * this.fps * this.speed : this.f0; }
  play(from = this.frame) {
    let f = Math.round(from);
    if (f < this.inF || f >= this.outF) f = this.inF;   // at the end (or outside the loop): start again from In
    this.f0 = f; this.t0 = this.now(); this.frame = f; this.playing = true; this.held = false;
  }
  pause() { this.frame = this.tick().frame; this.f0 = this.frame; this.playing = false; this.held = false; return this.frame; }
  seek(f) {
    this.frame = Math.max(0, Math.min(this.length - 1, Math.round(f)));
    this.f0 = this.frame; this.t0 = this.now();
  }
  setSpeed(s) { const f = this._exact(); this.speed = s; this.f0 = f; this.t0 = this.now(); }
  /** A tile is buffering: stop the clock where it is (hold=true), or carry on from there (hold=false). */
  hold(on) {
    if (on === this.held || !this.playing) return;
    const f = this._exact();
    this.held = on; this.f0 = f; this.t0 = this.now();
  }
  /**
   * The master frame now. Past Out it loops back to In (wrapped=true; the player re-seeks every tile) or, with loop
   * off, stops on Out (ended=true).
   */
  tick(t = this.now()) {
    let f = this._exact(t), wrapped = false, ended = false;
    if (this.playing && f >= this.outF + 1) {
      if (this.loop) {
        const span = this.outF - this.inF + 1;
        f = this.inF + ((f - this.inF) % span);
        this.f0 = f; this.t0 = t; wrapped = true;
      } else { f = this.outF; ended = true; this.playing = false; this.f0 = f; }
    }
    this.frame = Math.max(0, Math.min(this.length - 1, Math.floor(f)));
    return { frame: this.frame, exact: f, wrapped, ended };
  }
}

/**
 * Grid layout: the column x row arrangement that gives the biggest tiles in a W x H box, for n tiles of one aspect.
 * 2x2 on a normal screen, 1x4 (four across) on a very wide one, one column of four on a tall phone. With no usable
 * height (H < 1: the view grows with its content, as on a phone) it is two across, sized by the width.
 */
export function gridLayout(W, H, n, aspect = 16 / 9, gap = 6) {
  n = Math.max(1, Math.min(4, n | 0));
  const options = n === 1 ? [[1, 1]] : n === 2 ? [[2, 1], [1, 2]] : [[2, 2], [4, 1], [1, 4]];
  if (!(H >= 1)) {
    const cols = n === 1 ? 1 : 2, rows = Math.ceil(n / cols);
    const tw = Math.max(1, (W - gap * (cols - 1)) / cols);
    return { cols, rows, tw: Math.floor(tw), th: Math.floor(tw / aspect) };
  }
  let best = null;
  for (const [cols, rows] of options) {
    const cw = (W - gap * (cols - 1)) / cols, ch = (H - gap * (rows - 1)) / rows;
    if (cw <= 0 || ch <= 0) continue;
    const tw = Math.min(cw, ch * aspect), th = tw / aspect;
    if (!best || tw * th > best.tw * best.th + 0.5) best = { cols, rows, tw, th };
  }
  best ||= { cols: 1, rows: n, tw: W, th: W / aspect };
  return { cols: best.cols, rows: best.rows, tw: Math.floor(best.tw), th: Math.floor(best.th) };
}

/**
 * Keyboard: the transport's keys. Returns an action, or null for a key that is not ours (typing in a field never
 * reaches here: the player checks the target first).
 */
export function keyAction(e) {
  const k = e.key;
  const big = e.shiftKey ? 10 : 1;
  if (k === "ArrowLeft") return { step: -big };
  if (k === "ArrowRight") return { step: big };
  if (k === " " || k === "k" || k === "K") return { toggle: true };
  if (k === "Home") return { go: "in" };
  if (k === "End") return { go: "out" };
  if (k === "i" || k === "I") return { mark: "in" };
  if (k === "o" || k === "O") return { mark: "out" };
  if (k === "l" || k === "L") return { loop: true };
  if (k === "x" || k === "X") return { clearRange: true };
  if (k === "Escape") return { escape: true };
  if (k >= "1" && k <= "3" && !e.metaKey && !e.ctrlKey) return { mode: ["grid", "wipe", "onion"][+k - 1] };
  return null;
}

/** Tile frame label: "f 52" (0-based, the App's timeline numbering), plus "held" past the file's end. */
export const frameLabel = (f, held) => `f ${f}${held ? " · held" : ""}`;

/** Which of the four review slots a dropped file list fills: the slot dropped on first, then the empty ones, then the rest. */
export function dropSlots(count, onSlot, filled) {
  const order = [];
  if (onSlot != null) order.push(onSlot);
  for (let i = 0; i < 4; i++) if (!filled[i] && !order.includes(i)) order.push(i);
  for (let i = 0; i < 4; i++) if (!order.includes(i)) order.push(i);
  return order.slice(0, Math.min(4, count));
}
