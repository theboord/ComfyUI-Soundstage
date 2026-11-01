// A small QR code encoder (Model 2, byte mode, versions 1-10, error correction L or M): enough for a pairing URL of up to
// ~270 characters. Pure JS, no DOM. Written for Soundstage (MIT) after the ISO/IEC 18004 tables.
//
//   import { qrMatrix, qrSvg } from "./qr.mjs";
//   const { size, modules } = qrMatrix("https://mac.local:8443/soundstage/vcam/viewfinder?vk=...");   // modules[row][col]
//   el.innerHTML = qrSvg(url, { px: 220 });

// [ec codewords per block, [blocks, data codewords]...] for versions 1..10.
const BLOCKS = {
  L: [[7, [1, 19]], [10, [1, 34]], [15, [1, 55]], [20, [1, 80]], [26, [1, 108]], [18, [2, 68]], [20, [2, 78]], [24, [2, 97]],
    [30, [2, 116]], [18, [2, 68], [2, 69]]],
  M: [[10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]],
    [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]],
};
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const ECL_BITS = { L: 1, M: 0 };

// GF(256), polynomial 0x11D
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}

/** Reed-Solomon error-correction codewords of `data` (n of them). */
export function rsEncode(data, n) {
  const g = rsGenerator(n), r = new Array(n).fill(0);
  for (const d of data) {
    const f = d ^ r.shift();
    r.push(0);
    for (let j = 0; j < n; j++) r[j] ^= gmul(g[j + 1], f);
  }
  return r;
}

const utf8 = (s) => Array.from(new TextEncoder().encode(String(s)));

function capacity(ver, ecl) {
  const [, ...groups] = BLOCKS[ecl][ver - 1];
  return groups.reduce((a, [n, d]) => a + n * d, 0);
}

/** The data + error-correction codewords for text at a version, interleaved as the symbol stores them. */
function codewords(bytes, ver, ecl) {
  const [ec, ...groups] = BLOCKS[ecl][ver - 1];
  const cap = capacity(ver, ecl);
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);                                    // byte mode
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));   // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  const blocks = [];
  let k = 0;
  for (const [n, d] of groups) for (let b = 0; b < n; b++) { const blk = data.slice(k, k + d); k += d; blocks.push([blk, rsEncode(blk, ec)]); }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b[0].length));
  for (let i = 0; i < maxD; i++) for (const [d] of blocks) if (i < d.length) out.push(d[i]);
  for (let i = 0; i < ec; i++) for (const [, e] of blocks) out.push(e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function formatBits(ecl, mask) {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

function build(ver, ecl, cw, mask) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { m[y][x] = !!v; fn[y][x] = true; };
  // timing
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // finders + separators
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  // alignment
  const al = ALIGN[ver - 1], last = al.length - 1;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // format (reserved now, written after masking) + dark module
  const drawFormat = (bits) => {
    const b = (i) => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, 1);
  };
  drawFormat(0);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) { const v = (bits >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, v); set(c, a, v); }
  }
  // data, zig-zag from the bottom right
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && i < cw.length * 8) { m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
  drawFormat(formatBits(ecl, mask));
  return m;
}

/** A lighter version of the standard mask penalty (runs, 2x2 blocks, finder look-alikes, balance). */
function penalty(m) {
  const n = m.length;
  let p = 0, dark = 0;
  const line = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (b === n - 1 && run >= 5) p += run - 2; }
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      for (let b = 0; b + 6 < n; b++) {
        const s = [0, 1, 2, 3, 4, 5, 6].map((k) => get(a, b + k));
        if (s[0] && !s[1] && s[2] && s[3] && s[4] && !s[5] && s[6]) p += 40;
      }
    }
  };
  line((r, c) => m[r][c]);
  line((c, r) => m[r][c]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const v = m[y][x];
    if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3;
  }
  for (const row of m) for (const v of row) dark += v ? 1 : 0;
  p += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return p;
}

/** {version, size, modules: boolean[row][col], ecl, mask} for text (throws when it doesn't fit version 10). */
export function qrMatrix(text, { ecl = "M", mask = null } = {}) {
  const bytes = utf8(text);
  let ver = 1;
  while (ver <= 10 && capacity(ver, ecl) < bytes.length + (ver < 10 ? 2 : 3)) ver++;
  if (ver > 10) {
    if (ecl === "M") return qrMatrix(text, { ecl: "L", mask });
    throw new Error(`QR: ${bytes.length} bytes is too long`);
  }
  const cw = codewords(bytes, ver, ecl);
  let best = null;
  for (let k = 0; k < 8; k++) {
    if (mask !== null && k !== mask) continue;
    const mod = build(ver, ecl, cw, k), p = penalty(mod);
    if (!best || p < best.p) best = { p, mod, k };
  }
  return { version: ver, size: ver * 4 + 17, modules: best.mod, ecl, mask: best.k };
}

/** The QR code as an SVG string (dark modules on white, with a 4-module quiet zone). */
export function qrSvg(text, { px = 220, dark = "#111", light = "#fff", ecl = "M" } = {}) {
  const { size, modules } = qrMatrix(text, { ecl });
  const n = size + 8;
  let d = "";
  modules.forEach((row, y) => row.forEach((v, x) => { if (v) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
