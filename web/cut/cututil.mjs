// Drawing and waveform helpers shared by cut.mjs and the D12 panes (moved verbatim out of cut.mjs by S0a commit 2;
// cut.mjs re-exports them).

export const RUNG_COLORS = { clay: "#5b6475", look: "#3d6ea8", draft: "#7652b3", final: "#3c9561" };

export function sourceSize(src) {
  return [src.videoWidth || src.naturalWidth || src.width || 0, src.videoHeight || src.naturalHeight || src.height || 0];
}

/** Draw src into the rect (x, y, w, h), letterboxed. */
export function drawContain(ctx, src, x, y, w, h) {
  const [sw, sh] = sourceSize(src);
  if (!sw || !sh) return false;
  const s = Math.min(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return true;
}

export const PEAK_BLOCK = 256;

/** Max |sample| per PEAK_BLOCK samples across channels: enough to draw a waveform at any zoom. */
export function peaksOf(buffer) {
  const n = Math.ceil(buffer.length / PEAK_BLOCK);
  const peaks = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = peaks[i];
      const end = Math.min(d.length, (i + 1) * PEAK_BLOCK);
      for (let j = i * PEAK_BLOCK; j < end; j++) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; }
      peaks[i] = m;
    }
  }
  return peaks;
}
