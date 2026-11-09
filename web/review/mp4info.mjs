// Read a video's real frame rate and frame count from its MP4 / MOV header (ISO BMFF), so the synced review can line
// files up by frame number. Browsers never expose a video's fps; `duration * guess` is off by a frame on most renders.
//
//   mp4Info(arrayBuffer) -> { fps, frames, duration, width, height } | null   (null: not an MP4/MOV, or no video track)
//
// Reads only the boxes it needs: moov > trak > (tkhd for the size) mdia > (hdlr "vide", mdhd for the timescale)
// minf > stbl > stts (sample count x delta). The moov box may sit at the end of the file (not "fast start"): the whole
// file is scanned, so pass all of it. WebM and other containers return null (the caller falls back to a typed fps).

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

function* boxes(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let head = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(dv.getBigUint64(p + 8));
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head || p + size > end) return;   // truncated or corrupt: stop, never read past the buffer
    yield { type, start: p + head, end: p + size };
    p += size;
  }
}

function track(dv, trak) {
  const t = { handler: "", timescale: 0, mdDuration: 0, frames: 0, deltas: [], width: 0, height: 0 };
  const walk = (s, e) => {
    for (const b of boxes(dv, s, e)) {
      if (CONTAINERS.has(b.type)) walk(b.start, b.end);
      else if (b.type === "hdlr" && b.end - b.start >= 12) {
        t.handler = String.fromCharCode(dv.getUint8(b.start + 8), dv.getUint8(b.start + 9), dv.getUint8(b.start + 10), dv.getUint8(b.start + 11));
      } else if (b.type === "mdhd") {
        const v = dv.getUint8(b.start);
        if (v === 1) { t.timescale = dv.getUint32(b.start + 20); t.mdDuration = Number(dv.getBigUint64(b.start + 24)); }
        else { t.timescale = dv.getUint32(b.start + 12); t.mdDuration = dv.getUint32(b.start + 16); }
      } else if (b.type === "tkhd") {
        const v = dv.getUint8(b.start);
        const off = b.start + (v === 1 ? 88 : 76);   // width / height are the last 8 bytes, 16.16 fixed point
        if (off + 8 <= b.end) { t.width = dv.getUint32(off) / 65536; t.height = dv.getUint32(off + 4) / 65536; }
      } else if (b.type === "stts") {
        const n = dv.getUint32(b.start + 4);
        for (let i = 0; i < n && b.start + 16 + i * 8 <= b.end; i++) {
          const count = dv.getUint32(b.start + 8 + i * 8), delta = dv.getUint32(b.start + 12 + i * 8);
          t.frames += count;
          t.deltas.push([count, delta]);
        }
      }
    }
  };
  walk(trak.start, trak.end);
  return t;
}

/** Snap a measured rate to the usual video rates when it is within 0.05 % (23.976 reads as 24000/1001). */
export function snapFps(fps) {
  if (!(fps > 0)) return 0;
  for (const r of [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 120]) if (Math.abs(fps - r) / r < 5e-4) return r;
  return fps;
}

export function mp4Info(buf) {
  if (!buf || !(buf.byteLength >= 16)) return null;
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  let moov = null;
  for (const b of boxes(dv, 0, dv.byteLength)) if (b.type === "moov") { moov = b; break; }
  if (!moov) return null;
  for (const b of boxes(dv, moov.start, moov.end)) {
    if (b.type !== "trak") continue;
    const t = track(dv, b);
    if (t.handler !== "vide" || !t.timescale || !t.frames) continue;
    // The frame duration is the most common sample delta (a last frame or an edit can differ).
    const common = t.deltas.reduce((a, d) => (d[0] > a[0] ? d : a), [0, 0])[1];
    const fps = common ? snapFps(t.timescale / common) : 0;
    const duration = t.mdDuration / t.timescale;
    return { fps, frames: t.frames, duration, width: Math.round(t.width), height: Math.round(t.height) };
  }
  return null;
}
