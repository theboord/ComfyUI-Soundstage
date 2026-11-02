// Soundstage Cut, V3 Graphics: nine motion-graphics templates from the commercial's motion design system
// (share/Commercial/DESIGN_SYSTEM.md v1.1): title, kinetic type, lower third, callout zoom, PiP corner, dual PiP,
// device frame, split and end card. Pure functions plus a canvas painter for the viewer. The render is
// soundstage/cut/gfx.py, the Python twin: both compute the same draw ops for every frame
// (tests/fixtures/gfx_states.json pins them), so the preview and the render move the same way.
// A graphic: {id, template, start_frame, frames, text, text2, text3, blue, variant, x, y, color, accent, rect,
//             a: {shot_id, in, rung}, b: {shot_id, in, rung}, sfx}. x / y move it (1080p design px).

import * as TL from "./timeline.mjs";

export const W0 = 1920, H0 = 1080;
export const PAPER = "#F0EFED", PAPER2 = "rgba(240,239,237,0.68)", PAPER3 = "rgba(240,239,237,0.54)";
export const INK = "#0E0D10", BEZEL = "#0B0A0D", BLUE = "#28AAFF", BLUE_HI = "#78C8FF", ON_BLUE = "#0E0D10";
// Type scale (§5.3), Space Grotesk tracking (the App's vendored OFL face; Inter Tight is not vendored).
export const TYPE = {
  hero: { size: 240, lh: 216, track: -0.030, weight: 700 },
  display: { size: 152, lh: 144, track: -0.025, weight: 700 },
  title: { size: 96, lh: 96, track: -0.020, weight: 600 },
  headline: { size: 60, lh: 66, track: -0.010, weight: 600 },
  body: { size: 36, lh: 45, track: 0.0, weight: 500 },
  label: { size: 22, lh: 26, track: 0.06, weight: 600, upper: true },
  caption: { size: 20, lh: 26, track: 0.01, weight: 500 },
};
const OPTICAL_Y = 516;

export const TEMPLATES = {
  title: { label: "Title", frames: 48, text: "Change anything.", variant: "ink", variants: ["ink", "over"] },
  kinetic: { label: "Kinetic type", frames: 60, text: "Recast. Rebuild. Rewrite.", variant: "ink", variants: ["ink", "over"] },
  lower: { label: "Lower third", frames: 96, text: "Block a scene in 3D.", text2: "Step 3 · Set", variant: "clean", variants: ["clean", "glass"] },
  callout: { label: "Callout zoom", frames: 72, text: "Rebuild this clip as a 3D set", variant: "zoom", variants: ["zoom", "ring", "click"], rect: [1180, 720, 420, 64, 8] },
  pip: { label: "PiP corner", frames: 96, text: "", variant: "br", variants: ["br", "tr", "bl"] },
  dual: { label: "Dual PiP", frames: 96, text: "Generated", text2: "Rebuilt in 3D", variant: "even", variants: ["even", "stagger", "stack"] },
  device: { label: "Device frame", frames: 96, text: "", variant: "monitor", variants: ["monitor", "phone"] },
  split: { label: "Split", frames: 72, text: "Final", text2: "Clay", variant: "reveal", variants: ["reveal", "hold"] },
  endcard: { label: "End card", frames: 120, text: "A film set inside ComfyUI.", text2: "github.com/theboord/ComfyUI-Soundstage", text3: "", variant: "ink", variants: ["ink"] },
};
export const VARIANT_LABEL = { ink: "On black", over: "Over the picture", clean: "Clean (scrim)", glass: "Glass plate", zoom: "Zoom in", ring: "Ring only",
  click: "Zoom + cursor click", br: "Bottom right", tr: "Top right", bl: "Bottom left", even: "Side by side", stagger: "Stagger", stack: "Stack (window + still card)",
  monitor: "Monitor", phone: "Phone", reveal: "Reveal, then wipe on", hold: "Reveal and hold" };
// Which source slots each template uses (a = window / screen / left side, b = second window / card / right side).
export const SLOTS = { pip: ["a"], dual: ["a", "b"], device: ["a"], split: ["a", "b"] };
export const RUNGS = ["auto", "clay", "look", "draft", "final", "source"];
const HEX = /^#[0-9a-fA-F]{6}$/;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d = 0) => { const f = Number(v); return v != null && v !== "" && Number.isFinite(f) ? f : d; };
/** Round for the ops (the Python twin rounds the same way, half up). */
export const r3 = (v, n = 3) => { const x = Math.floor(Number(v) * 10 ** n + 0.5) / 10 ** n; return x === 0 ? 0 : x; };

// ------------------------------------------------------------------------------------------- easing (§8)

export function cubicBezier(x1, y1, x2, y2) {
  const bx = (s) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bx(m) < u) lo = m; else hi = m; }
    return by((lo + hi) / 2);
  };
}
export const EASE = {
  glide: cubicBezier(0.20, 0.00, 0.00, 1.00),
  swift: cubicBezier(0.40, 0.00, 0.20, 1.00),
  exit: cubicBezier(0.30, 0.00, 0.80, 0.15),
  enter: cubicBezier(0.05, 0.70, 0.10, 1.00),
  fade: (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1)),
  linear: (u) => clamp(u, 0, 1),
};
export function ao(f, { a = 3, m = 8, s = 5, A = 0.04, O = 0.03 } = {}) {
  if (f <= 0) return 0;
  if (f <= a) return -A * EASE.fade(f / a);
  if (f <= a + m) return -A + (1 + O + A) * EASE.glide((f - a) / m);
  if (f <= a + m + s) return 1 + O - O * EASE.fade((f - a - m) / s);
  return 1;
}
export function spring(f, wn = 15.23, zeta = 0.75, fps = 24) {
  if (f <= 0) return 0;
  const t = f / fps, wd = wn * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + ((zeta * wn) / wd) * Math.sin(wd * t));
}
export const springFast = (f) => spring(f, 22.85);
const SLAM = [1.100, 1.104, 1.111, 1.115, 1.062, 1.020, 1.001, 0.991, 0.986, 0.985, 0.986, 0.990, 0.995, 0.999, 1.000];
export function slamScale(f) {
  if (f <= 0) return SLAM[0];
  if (f >= SLAM.length - 1) return 1;
  const i = Math.floor(f);
  return SLAM[i] + (SLAM[i + 1] - SLAM[i]) * (f - i);
}
export const expo = (s0, s1, p) => s0 * (s1 / s0) ** p;
const snap8 = (y) => Math.floor(y / 8) * 8;
const U = (f, start, n) => (n > 0 ? clamp((f - start) / n, 0, 1) : 1);

// ------------------------------------------------------------------------------------------- normalise

function src(v, rung = "auto") {
  if (!v || typeof v !== "object" || !v.shot_id) return null;
  return { shot_id: String(v.shot_id), in: Math.max(0, Math.round(num(v.in))), rung: RUNGS.includes(v.rung) ? v.rung : rung };
}

/** The V3 graphics list, clamped (twin: soundstage/cut/gfx.py normalize_graphics). */
export function normalizeGraphics(list) {
  const seen = new Set();
  const out = (Array.isArray(list) ? list : []).filter((g) => g && typeof g === "object").map((g, i) => {
    const tpl = TEMPLATES[g.template] ? g.template : "title";
    const d = TEMPLATES[tpl];
    let id = g.id != null ? String(g.id) : `g${i + 1}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    const item = {
      id, template: tpl, start_frame: Math.max(0, Math.round(num(g.start_frame))),
      frames: clamp(Math.round(num(g.frames, d.frames)), 12, 2400),
      text: String(g.text != null ? g.text : d.text ?? "").slice(0, 200),
      text2: String(g.text2 != null ? g.text2 : d.text2 ?? "").slice(0, 200),
      text3: String(g.text3 != null ? g.text3 : d.text3 ?? "").slice(0, 200),
      blue: String(g.blue || "").slice(0, 60),
      variant: d.variants.includes(g.variant) ? g.variant : d.variant,
      x: r3(clamp(num(g.x), -1920, 1920), 1), y: r3(clamp(num(g.y), -1080, 1080), 1),
      color: typeof g.color === "string" && HEX.test(g.color) ? g.color.toUpperCase() : PAPER,
      accent: typeof g.accent === "string" && HEX.test(g.accent) ? g.accent.toUpperCase() : BLUE,
      sfx: g.sfx !== false,
    };
    if (tpl === "callout") {
      const r0 = Array.isArray(g.rect) ? g.rect : d.rect;
      const r = [...r0, ...d.rect.slice(r0.length)].slice(0, 5).map((v) => num(v));
      const w = clamp(r[2], 8, 1920), h = clamp(r[3], 8, 1080);
      item.rect = [r3(clamp(r[0], 0, 1920 - w), 1), r3(clamp(r[1], 0, 1080 - h), 1), r3(w, 1), r3(h, 1), r3(clamp(r[4], 0, 200), 1)];
    }
    let a = src(g.a, tpl === "split" ? "final" : "auto"), b = src(g.b, tpl === "split" ? "clay" : "auto");
    if (tpl === "split" && a && !b) b = { shot_id: a.shot_id, in: a.in, rung: "clay" };
    if (a) item.a = a;
    if (b) item.b = b;
    return item;
  });
  return out.sort((x, y) => x.start_frame - y.start_frame);
}

/** The graphics showing at record frame f, bottom to top: [{g, lf}]. */
export function graphicsAt(project, f) {
  return (project.graphics || []).filter((g) => g.start_frame <= f && f < g.start_frame + g.frames).map((g) => ({ g, lf: f - g.start_frame }));
}

/** A new graphic of a template at a record frame, with its defaults (sources: the clip under the playhead). */
export function newGraphic(template, start_frame, { shot_id = null, in: inF = 0, shot_b = null } = {}) {
  const d = TEMPLATES[template] || TEMPLATES.title;
  const g = { id: `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, template, start_frame, frames: d.frames };
  if (SLOTS[template] && shot_id) {
    g.a = { shot_id, in: inF, rung: template === "split" ? "final" : "auto" };
    if (SLOTS[template].includes("b")) g.b = { shot_id: shot_b || shot_id, in: inF, rung: template === "split" ? "clay" : "auto" };
  }
  return normalizeGraphics([g])[0];
}

// ------------------------------------------------------------------------------------------- ops

const type = (token, o) => ({ op: "text", token, ...o });

function rise(f, start, em, outStart = null) {
  let dy = 0.6 * em * (1 - EASE.glide(U(f, start, 14)));
  let al = EASE.fade(U(f, start, 8));
  if (outStart != null && f >= outStart) {
    const u = U(f, outStart, 8);
    dy -= 0.15 * em * EASE.exit(u);
    al *= 1 - EASE.fade(u);
  }
  return [dy, al];
}
const chipIn = (f, start) => (f < start ? [0.92, 0] : [0.92 + 0.08 * springFast(f - start), EASE.fade((f - start) / 6)]);
function windowInOut(f, n, start = 0) {
  const p = EASE.glide(U(f, start, 16));
  let dy = 48 * (1 - p), sc = 0.94 + 0.06 * p, al = EASE.fade(U(f, start, 8));
  const sh = 1 + p;
  if (f >= n - 10) {
    const q = EASE.exit(U(f, n - 10, 10));
    dy += 32 * q;
    sc *= 1 - 0.03 * q;
    al *= 1 - EASE.fade(U(f, n - 10, 10));
  }
  return [dy, sc, al, sh];
}
function recede(f, n, outLen = 14) {
  let k = EASE.glide(U(f, 0, 16));
  if (f >= n - outLen) k *= 1 - EASE.glide(U(f, n - outLen, outLen));
  return k;
}
function win(s, x, y, w, h, r, dy = 0, sc = 1, al = 1, sh = 2, dim = 1, still = false) {
  const cx = x + w / 2, cy = y + h / 2, ww = w * sc, hh = h * sc;
  return { op: "window", src: s, x: r3(cx - ww / 2), y: r3(cy - hh / 2 + dy), w: r3(ww), h: r3(hh), r: r3(r * sc), alpha: r3(al), shadow: r3(sh), dim: r3(dim), still };
}

/** The draw ops for graphic g at local frame f (twin of gfx.py state_at). */
export function stateAt(g, f) {
  const tpl = g.template, n = g.frames;
  const ox = g.x || 0, oy = g.y || 0, col = g.color || PAPER, acc = g.accent || BLUE;
  const ops = [];
  if (tpl === "title" || tpl === "kinetic") {
    if (g.variant === "over") { const k = recede(f, n); ops.push({ op: "recede", k: r3(k) }, { op: "scrim", kind: "full", alpha: r3(k) }); }
    else ops.push({ op: "fill", color: INK, alpha: 1 });
  }
  if (tpl === "title") {
    let lines = String(g.text).split("\n").filter((l) => l.trim()).slice(0, 2);
    if (!lines.length) lines = [" "];
    const oneWord = lines.length === 1 && !lines[0].trim().includes(" ") && lines[0].trim().length <= 9;
    const tok = oneWord ? "hero" : lines.every((x) => x.length <= 18) ? "display" : "title";
    const t = TYPE[tok];
    lines.forEach((ln, i) => {
      const y = OPTICAL_Y + (i - (lines.length - 1) / 2) * t.lh;
      const [dy, al] = rise(f, 3 * i, t.size, n - 8);
      const left = lines.length > 1;
      ops.push(type(tok, { text: ln, x: r3((left ? 96 : 960) + ox), y: r3(y + oy + dy), align: left ? "left" : "center", anchor: "middle", color: col,
        blue: g.blue || "", accent: acc, alpha: r3(al), clip: [r3(y + oy - t.lh / 2 - 0.1 * t.size), r3(y + oy + t.lh / 2 + 0.1 * t.size)] }));
    });
  } else if (tpl === "kinetic") {
    let words = String(g.text).split(/\s+/).filter(Boolean);
    if (!words.length) words = [" "];
    const tok = Math.max(...words.map((w) => w.length)) <= 9 ? "hero" : "display";
    const em = TYPE[tok].size;
    words.forEach((wd, k) => {
      const s0 = 12 * k;
      const end = k + 1 < words.length ? 12 * (k + 1) - 2 : null;
      if (f < s0 || (end != null && f >= end + 6)) return;
      const lf = f - s0;
      let sc, al, blur, dy;
      if (k === 0) { sc = slamScale(lf); al = EASE.fade(lf / 3); blur = 4 * (1 - U(lf, 3, 4)); dy = 0; }
      else { sc = 1; al = EASE.fade(lf / 6); blur = 0; dy = 0.4 * em * (1 - EASE.glide(U(lf, 0, 12))); }
      if (end != null && f >= end) { const u = U(f, end, 6); dy -= 0.4 * em * EASE.exit(u); al *= 1 - EASE.fade(u); }
      if (end == null && f >= n - 8) { const u = U(f, n - 8, 8); dy -= 0.15 * em * EASE.exit(u); al *= 1 - EASE.fade(u); }
      ops.push(type(tok, { text: wd, x: r3(960 + ox), y: r3(OPTICAL_Y + oy + dy), align: "center", anchor: "middle", color: col, blue: g.blue || "",
        accent: acc, alpha: r3(al), scale: r3(sc), blur: r3(blur) }));
    });
  } else if (tpl === "lower") {
    const sk = EASE.fade(U(f, 0, 8)) * (1 - EASE.fade(U(f, n - 8, 8)));
    if (g.variant === "glass") ops.push({ op: "plate", x: r3(72 + ox), y: r3(826 + oy), w: 900, h: 160, r: 16, alpha: r3(sk) });
    else ops.push({ op: "scrim", kind: "bottom", alpha: r3(sk) });
    let [sc, al] = chipIn(f, 0);
    if (f >= n - 8) al *= 1 - EASE.fade(U(f, n - 8, 8));
    if (g.text2) ops.push(type("label", { text: g.text2, x: r3(96 + ox), y: r3(880 + oy), align: "left", anchor: "baseline", color: acc, alpha: r3(al), scale: r3(sc) }));
    const [dy, al2] = rise(f, 3, TYPE.headline.size, n - 8);
    ops.push(type("headline", { text: g.text, x: r3(96 + ox), y: r3(952 + oy + dy), align: "left", anchor: "baseline", color: col, blue: g.blue || "",
      accent: acc, alpha: r3(al2), maxw: 852, clip: [r3(952 + oy - 66), r3(952 + oy + 24)] }));
  } else if (tpl === "callout") {
    const [x, y, w, h, rad] = g.rect;
    const cx = x + w / 2, cy = y + h / 2;
    const zs = Math.min((0.60 * 1920) / (w + 96), (0.50 * 1080) / (h + 96), 2.0);
    const zoom = g.variant !== "ring" && zs >= 1.4;
    const out0 = n - 14;
    let p = zoom ? EASE.glide(U(f, 0, 18)) : 0;
    if (zoom && f >= out0) p *= 1 - EASE.glide(U(f, out0, 14));
    const z = zoom ? expo(1, zs, p) : 1;
    const camx = clamp(960 + (cx - 960) * p, 960 / z, 1920 - 960 / z);
    const camy = clamp(540 + (cy - 540) * p, 540 / z, 1080 - 540 / z);
    if (zoom) ops.push({ op: "zoom", cx: r3(camx), cy: r3(camy), z: r3(z, 4) });
    const proj = (px, py) => [(px - camx) * z + 960, (py - camy) * z + 540];
    const [X0, Y0] = proj(x, y), [X1, Y1] = proj(x + w, y + h);
    const fadeOut = 1 - EASE.fade(U(f, out0, 6));
    const ring0 = zoom ? 10 : 0;
    if (f >= ring0) {
      const rs = 1.08 - 0.08 * spring(f - ring0), ra = EASE.fade((f - ring0) / 6) * fadeOut;
      ops.push({ op: "ring", x: r3(X0 - 8), y: r3(Y0 - 8), w: r3(X1 - X0 + 16), h: r3(Y1 - Y0 + 16), r: r3(Math.min(rad * z + 8, (Y1 - Y0 + 16) / 2)),
        scale: r3(rs), alpha: r3(ra), color: acc });
    }
    const chip0 = ring0 + 4;
    if (g.text && f >= chip0) {
      const [sc, al] = chipIn(f, chip0);
      const below = (Y0 + Y1) / 2 < 540;
      ops.push({ op: "chip", text: g.text, cx: r3(clamp((X0 + X1) / 2, 96, 1824)), y: r3(below ? Y1 + 8 + 16 : Y0 - 8 - 16 - 40), h: 40, fill: "blue", color: acc,
        scale: r3(sc), alpha: r3(al * fadeOut) });
    }
    if (g.variant === "click") {
      const click = chip0 + 8, sx = cx + 260, sy = cy + 180;
      const q = EASE.glide(U(f, 0, 14));
      const [PX, PY] = proj(sx + (cx - sx) * q, sy + (cy - sy) * q);
      let press = 1;
      if (f >= click) { const lf = f - click; press = lf < 3 ? 1 - 0.12 * EASE.fade(lf / 3) : 0.88 + 0.12 * springFast(lf - 3); }
      const cur = { op: "cursor", x: r3(PX), y: r3(PY), scale: r3(press * Math.min(1.5, z)), alpha: r3(fadeOut) };
      if (f >= click && f < click + 10) { const u = EASE.glide((f - click) / 10); cur.ripple = [r3(6 + 22 * u), r3(0.9 * (1 - u))]; }
      ops.push(cur);
    }
  } else if (tpl === "pip" || tpl === "dual") {
    ops.push({ op: "recede", k: r3(recede(f, n, 10)) });
    if (tpl === "pip") {
      const [px, py] = { br: [1264, 669], tr: [1264, 96], bl: [96, 669] }[g.variant];
      const [dy, sc, al, sh] = windowInOut(f, n);
      ops.push(win("a", px + ox, py + oy, 560, 315, 20, dy, sc, al, sh));
      if (g.text) ops.push(type("label", { text: g.text, x: r3(px + ox), y: r3(snap8(py - 16) + oy + dy), align: "left", anchor: "baseline", color: col, alpha: r3(al) }));
    } else {
      const v = g.variant;
      let [ra, rb] = v === "even" ? [[96, 300, 852, 480, 28], [972, 300, 852, 480, 28]] : [[96, 152, 998, 562, 28], [972, 586, 706, 398, 28]];
      if (v === "stack") rb = [972, 312, 414, 518, 16];
      const [da, sa, aa, ha] = windowInOut(f, n, 0);
      const [db, sb, ab, hb] = windowInOut(f, n, 4);
      ops.push(win("a", ra[0] + ox, ra[1] + oy, ra[2], ra[3], ra[4], da, sa, aa, ha));
      ops.push(win("b", rb[0] + ox, rb[1] + oy, rb[2], rb[3], rb[4], db, sb, ab, hb + (v !== "even" ? 1 : 0) * EASE.glide(U(f, 4, 16)), 1, v === "stack"));
      if (v === "even") {
        for (const [txt, r_, d_, a_] of [[g.text, ra, da, aa], [g.text2, rb, db, ab]]) {
          if (txt) ops.push(type("label", { text: txt, x: r3(r_[0] + ox), y: r3(280 + oy + d_), align: "left", anchor: "baseline", color: col, alpha: r3(a_) }));
        }
      } else if (g.text) {
        const [labY, labX] = v === "stack" ? [snap8(rb[1] - 16), rb[0]] : [snap8(ra[1] - 16), ra[0]];
        const al_ = windowInOut(f, n, v === "stack" ? 8 : 0)[2];
        ops.push(type("label", { text: g.text, x: r3(labX + ox), y: r3(labY + oy), align: "left", anchor: "baseline", color: col, alpha: r3(al_) }));
      }
    }
  } else if (tpl === "device") {
    ops.push({ op: "fill", color: INK, alpha: 1 });
    const [dy, sc, al] = windowInOut(f, n);
    const phone = g.variant === "phone";
    const outer = phone ? [1352, 138, 384, 804] : [374, 204, 1172, 672], screen = phone ? [1364, 150, 360, 780] : [388, 218, 1144, 644];
    const ro = phone ? 60 : 28, rs = phone ? 48 : 14;
    const cx = outer[0] + outer[2] / 2 + ox, cy = outer[1] + outer[3] / 2 + oy;
    const tr = (rx, ry, rw, rh) => [cx + (rx + ox - cx) * sc, cy + (ry + oy - cy) * sc + dy, rw * sc, rh * sc];
    const [bx, by, bw, bh] = tr(...outer);
    ops.push({ op: "bezel", x: r3(bx), y: r3(by), w: r3(bw), h: r3(bh), r: r3(ro * sc), alpha: r3(al), shadow: 3 });
    const [sx, sy, sw, sh] = tr(...screen);
    ops.push({ op: "window", src: "a", x: r3(sx), y: r3(sy), w: r3(sw), h: r3(sh), r: r3(rs * sc), alpha: r3(al), shadow: 0, dim: 1, still: false });
    if (g.text) {
      if (phone) {
        const [dy2, al2] = rise(f, 6, TYPE.headline.size, n - 8);
        ops.push(type("title", { text: g.text, x: r3(96 + ox), y: r3(OPTICAL_Y + oy + dy2), align: "left", anchor: "middle", color: col, blue: g.blue || "",
          accent: acc, alpha: r3(al2), maxw: 998 }));
      } else {
        ops.push(type("label", { text: g.text, x: r3(outer[0] + 14 + ox), y: r3(snap8(outer[1] - 16) + oy + dy), align: "left", anchor: "baseline", color: col, alpha: r3(al) }));
      }
    }
  } else if (tpl === "split") {
    const hold = g.variant === "hold";
    let xd = 960 * EASE.glide(U(f, 0, 14));
    const fin0 = n - 24;
    if (!hold && f >= fin0) xd = 960 + 960 * EASE.swift(U(f, fin0, 24));
    ops.push({ op: "split", x: r3(xd), left: "a", right: "b" });
    if (g.text) { const [sc, al] = chipIn(f, 8); ops.push({ op: "chip", text: g.text, x: 96, y: 96, h: 40, fill: "glass", color: PAPER, scale: r3(sc), alpha: r3(al) }); }
    if (g.text2) {
      let [sc, al] = chipIn(f, 0);
      if (!hold && f >= fin0) al *= 1 - EASE.fade(U(f, fin0, 8));
      ops.push({ op: "chip", text: g.text2, right: 1824, y: 96, h: 40, fill: "glass", color: PAPER, scale: r3(sc), alpha: r3(al) });
    }
  } else if (tpl === "endcard") {
    ops.push({ op: "fill", color: INK, alpha: 1 });
    const p = EASE.glide(U(f, 0, 14));
    ops.push({ op: "logo", cx: r3(960 + ox), y: r3(400 + oy + 12 * (1 - p)), w: 640, alpha: r3(EASE.fade(U(f, 0, 14))) });
    for (const [txt, tok, base, start, c] of [[g.text, "headline", 600, 12, col], [g.text2, "body", 664, 24, PAPER2], [g.text3, "caption", 936, 36, PAPER3]]) {
      if (!txt) continue;
      const [dy, al] = rise(f, start, TYPE[tok].size);
      ops.push(type(tok, { text: txt, x: r3(960 + ox), y: r3(base + oy + dy), align: "center", anchor: "baseline", color: c, alpha: r3(al),
        clip: [r3(base + oy - TYPE[tok].lh), r3(base + oy + 0.35 * TYPE[tok].size)] }));
    }
  }
  return ops;
}

// ------------------------------------------------------------------------------------------- sound (§13)

export const SFX = { "SFX-01": ["tick", -28], "SFX-02": ["swap", -28], "SFX-03": ["thump", -10], "SFX-04": ["whoosh", -20], "SFX-05": ["whoosh_out", -24],
  "SFX-06": ["riser", -22], "SFX-07": ["ping", -24], "SFX-08": ["click", -26], "SFX-09": ["air", -22], "SFX-12": ["puff", -30], "SFX-15": ["logo_swell", -14] };
const pan = (xc) => { const p = clamp((xc - 960) / 1920, -0.5, 0.5); return p < -0.15 ? "l" : p > 0.15 ? "r" : "c"; };

/** [{sfx, frame (local), gain_db, pan, variant, label}]: one designed sound per graphic event (twin of gfx.py sfx_cues). */
export function sfxCues(g) {
  if (g.sfx === false) return [];
  const tpl = g.template, n = g.frames, out = [], ox = g.x || 0;
  const cue = (sid, frame, p = "c", variant = "", extra = 0, label = "") => {
    if (frame >= 0 && frame < n) out.push({ sfx: sid, frame: Math.trunc(frame), gain_db: r3(SFX[sid][1] + 1 + extra, 1), pan: p, variant, label: label || sid });
  };
  if (tpl === "title") {
    const lines = String(g.text).split("\n").filter((l) => l.trim()).slice(0, 2);
    for (let i = 0; i < Math.max(1, lines.length); i++) cue("SFX-01", 3 * i, "c", String((i % 3) + 1), 0, "type rise");
  } else if (tpl === "kinetic") {
    const words = String(g.text).split(/\s+/).filter(Boolean);
    cue("SFX-03", 7, "c", "", 0, "slam");
    for (let k = 1; k < words.length; k++) cue("SFX-02", 12 * k - 2, "c", "", 0, "type swap");
  } else if (tpl === "lower") {
    if (g.text2) cue("SFX-12", 0, "l", "", 0, "eyebrow");
    cue("SFX-01", 3, "l", "2", 0, "line rise");
  } else if (tpl === "callout") {
    const [x, , w, h] = g.rect;
    const zs = Math.min((0.60 * 1920) / (w + 96), (0.50 * 1080) / (h + 96), 2.0);
    const zoom = g.variant !== "ring" && zs >= 1.4, p = pan(x + w / 2);
    if (zoom) { cue("SFX-06", 0, "c", "", 0, "zoom in"); cue("SFX-05", n - 14, "c", "", -6, "zoom out"); }
    cue("SFX-07", zoom ? 10 : 0, p, "", 0, "focus ring");
    if (g.text) cue("SFX-12", (zoom ? 10 : 0) + 4, p, "", 0, "chip");
    if (g.variant === "click") cue("SFX-08", (zoom ? 10 : 0) + 12, p, "", 0, "click");
  } else if (tpl === "pip") {
    const side = { br: 1544, tr: 1544, bl: 376 }[g.variant] + ox;
    cue("SFX-04", 0, pan(side), "", 0, "window in");
    cue("SFX-05", n - 10, pan(side), "", 0, "window out");
  } else if (tpl === "dual") {
    cue("SFX-04", 0, "l", "", 0, "window A in");
    cue("SFX-04", 4, "r", "up2", 0, "window B in");
    cue("SFX-05", n - 10, "c", "", 0, "windows out");
  } else if (tpl === "device") {
    cue("SFX-04", 0, g.variant === "phone" ? pan(1544 + ox) : "c", "down3", 0, "device in");
    cue("SFX-05", n - 10, "c", "", 0, "device out");
  } else if (tpl === "split") {
    cue("SFX-09", 0, "l", "", 0, "divider");
    if (g.variant !== "hold") cue("SFX-09", n - 24, "r", "", 0, "divider out");
  } else if (tpl === "endcard") {
    cue("SFX-15", 0, "c", "", 0, "sonic logo");
    if (g.text) cue("SFX-01", 12, "c", "1", 0, "tagline");
    if (g.text2) cue("SFX-01", 24, "c", "2", 0, "repo line");
  }
  return out;
}

/** The pack file for a cue: the panned file, else the centred one, else the plain one (gfx_sfx.py file_key). */
export function fileKey(cue, library) {
  const stem = `${cue.sfx}_${SFX[cue.sfx][0]}${cue.variant ? `_${cue.variant}` : ""}`;
  for (const k of [`${stem}_${cue.pan || "c"}`, `${stem}_c`, stem]) if (library?.[k]) return k;
  return null;
}

/** A2 clips for every graphic's cues, tagged meta.gfx = the graphic's id (library: {key: {url, seconds}}). */
export function gfxClips(project, library, fps = 24) {
  const out = [];
  for (const g of project.graphics || []) {
    for (const c of sfxCues(g)) {
      const k = fileKey(c, library);
      const f = k && library[k];
      if (!f?.url) continue;
      const frames = Math.max(1, Math.round((f.seconds || 0.1) * fps));
      out.push({ id: `gfx_${g.id}_${c.frame}_${c.sfx}`, track: TL.ROLE_TRACK.sfx, url: f.url, start_frame: g.start_frame + c.frame, in: 0, out: frames, frames,
        gain_db: c.gain_db, label: `${c.sfx} ${c.label}`, meta: { gfx: g.id, sfx: c.sfx, cue: c.label } });
    }
  }
  return out;
}

/** The project's audio with the graphics' cues rebuilt (re-running never stacks them; a moved graphic moves its sounds). */
export function withGfxClips(project, clips) {
  return TL.normalizeAudio([...(project.audio || []).filter((a) => !a.meta?.gfx), ...clips], project.fps);
}

// ------------------------------------------------------------------------------------------- canvas painter (the viewer)

const FONT = "'Soundstage Grotesk', 'Space Grotesk', ui-sans-serif, system-ui, sans-serif";
function rr(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.videoWidth || img.naturalWidth || img.width, ih = img.videoHeight || img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const k = Math.max(w / iw, h / ih), cw = w / k, ch = h / k;
  ctx.drawImage(img, (iw - cw) / 2, (ih - ch) / 2, cw, ch, x, y, w, h);
}
const SHADOW = { 1: [0, 4, 12, 0.3], 2: [0, 12, 28, 0.34], 3: [0, 24, 48, 0.4] };
let _logo = null;
function logoImage() {
  if (_logo || typeof Image === "undefined") return _logo;
  _logo = new Image();
  _logo.src = new URL("./gfx_logo.png", import.meta.url).href;
  return _logo;
}

/** The letterbox paint() uses: design (1920x1080) units -> a W x H view is x*s, y*s + oy. */
export function designBox(W, H) { const s = W / W0; return { s, oy: (H - H0 * s) / 2 }; }

/** A point on a W x H view (pixels from its top-left) in design units, the inverse of paint()'s mapping. */
export function viewToDesign(x, y, W, H) { const { s, oy } = designBox(W, H); return [x / s, (y - oy) / s]; }

/**
 * Paint ops over the viewer. pic: the V1 picture (a canvas of W x H, already drawn); sources: {a, b} images or
 * canvases (null shows a dark plate). The render (gfx.py GfxPainter) draws the same ops with Pillow.
 */
export function paint(ctx, pic, ops, sources, W, H) {
  const s = W / W0, oy = (H - H0 * s) / 2;
  const X = (v) => v * s, Y = (v) => v * s + oy;
  for (const op of ops) {
    if (op.op === "zoom") {
      const hw = W / 2 / op.z, hh = H / 2 / op.z;
      ctx.drawImage(pic, X(op.cx) - hw, Y(op.cy) - hh, hw * 2, hh * 2, 0, 0, W, H);
    } else if (op.op === "recede" && op.k > 0.001) {
      const k = op.k, sc = 1 + 0.03 * k;
      ctx.save();
      ctx.filter = `blur(${(4 * k * s).toFixed(2)}px) brightness(${(1 - 0.28 * k).toFixed(3)})`;
      ctx.drawImage(pic, W / 2 - (W * sc) / 2, H / 2 - (H * sc) / 2, W * sc, H * sc);
      ctx.restore();
    } else if (op.op === "split") {
      const xd = X(op.x);
      const right = sources[op.right], left = sources[op.left];
      if (right) drawCover(ctx, right, 0, 0, W, H);
      if (left && xd > 0) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, xd, H); ctx.clip(); drawCover(ctx, left, 0, 0, W, H); ctx.restore(); }
    }
  }
  for (const op of ops) {
    const k = op.op;
    if (k === "fill" && op.alpha > 0) { ctx.save(); ctx.globalAlpha = op.alpha; ctx.fillStyle = op.color; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    else if (k === "scrim" && op.alpha > 0.001) {
      ctx.save();
      if (op.kind === "full") { ctx.fillStyle = `rgba(14,13,16,${0.55 * op.alpha})`; ctx.fillRect(0, 0, W, H); }
      else {
        const gr = ctx.createLinearGradient(0, Y(1080), 0, Y(0));
        gr.addColorStop(0, `rgba(14,13,16,${0.72 * op.alpha})`); gr.addColorStop(0.18, `rgba(14,13,16,${0.48 * op.alpha})`); gr.addColorStop(0.42, "rgba(14,13,16,0)");
        ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
    } else if (k === "split") {
      const xd = X(op.x);
      if (xd > 0 && xd < W) {
        ctx.save(); ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fillRect(xd - 2 * s, 0, 4 * s, H);
        ctx.fillStyle = "rgba(240,239,237,.8)"; ctx.fillRect(xd - s, 0, 2 * s, H); ctx.restore();
      }
    } else if ((k === "window" || k === "bezel" || k === "plate") && op.alpha > 0.002) {
      const x = X(op.x), y = Y(op.y), w = op.w * s, h = op.h * s, r = op.r * s;
      ctx.save();
      ctx.globalAlpha = op.alpha * (k === "plate" ? 0.6 : 1);
      const tier = Math.round(op.shadow || 0);
      if (SHADOW[tier]) { const [dx, dy, bl, a] = SHADOW[tier]; ctx.shadowColor = `rgba(0,0,0,${a})`; ctx.shadowOffsetX = dx * s; ctx.shadowOffsetY = dy * s; ctx.shadowBlur = bl * s; }
      rr(ctx, x, y, w, h, r);
      ctx.fillStyle = k === "bezel" ? BEZEL : k === "plate" ? "rgba(20,17,24,.56)" : "#141118";
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = op.alpha;
      rr(ctx, x, y, w, h, r);
      if (k === "window") {
        ctx.save(); ctx.clip();
        const img = sources[op.src];
        if (img) { if (op.dim < 1) ctx.filter = `brightness(${op.dim})`; drawCover(ctx, img, x, y, w, h); }
        ctx.restore();
      }
      ctx.strokeStyle = k === "bezel" ? "rgba(255,255,255,.10)" : "rgba(255,255,255,.14)"; ctx.lineWidth = 1; rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r); ctx.stroke();
      ctx.restore();
    } else if (k === "ring" && op.alpha > 0.002) {
      const cx = X(op.x + op.w / 2), cy = Y(op.y + op.h / 2), w = op.w * s * op.scale, h = op.h * s * op.scale, r = op.r * s * op.scale;
      ctx.save(); ctx.globalAlpha = op.alpha;
      ctx.strokeStyle = op.color; ctx.globalAlpha = op.alpha * 0.18; ctx.lineWidth = 8 * s; rr(ctx, cx - w / 2 - 4 * s, cy - h / 2 - 4 * s, w + 8 * s, h + 8 * s, r + 4 * s); ctx.stroke();
      ctx.globalAlpha = op.alpha; ctx.lineWidth = 3 * s; rr(ctx, cx - w / 2, cy - h / 2, w, h, r); ctx.stroke();
      ctx.restore();
    } else if (k === "chip" && op.alpha > 0.002) chip(ctx, op, s, X, Y);
    else if (k === "text" && op.alpha > 0.002) text(ctx, op, s, X, Y);
    else if (k === "logo" && op.alpha > 0.002) {
      const lg = logoImage();
      if (lg && lg.complete && lg.naturalWidth) {
        const w = op.w * s, h = (w * lg.naturalHeight) / lg.naturalWidth;
        ctx.save(); ctx.globalAlpha = op.alpha; ctx.drawImage(lg, X(op.cx) - w / 2, Y(op.y), w, h); ctx.restore();
      }
    } else if (k === "cursor" && op.alpha > 0.002) cursor(ctx, op, s, X, Y);
  }
}

function setFont(ctx, t, size) {
  ctx.font = `${t.weight} ${size}px ${FONT}`;
  try { ctx.letterSpacing = `${(t.track * size).toFixed(2)}px`; } catch { /* older canvas */ }
  ctx.fontKerning = "normal";
}

function text(ctx, op, s, X, Y) {
  const t = TYPE[op.token];
  const str = t.upper ? op.text.toUpperCase() : op.text;
  let size = t.size * s * (op.scale || 1);
  ctx.save();
  setFont(ctx, t, size);
  let width = ctx.measureText(str).width - t.track * size;
  if (op.maxw && width > op.maxw * s) { size *= (op.maxw * s) / width; setFont(ctx, t, size); width = ctx.measureText(str).width - t.track * size; }
  ctx.globalAlpha = op.alpha;
  if (op.blur > 0.05) ctx.filter = `blur(${(op.blur * s).toFixed(2)}px)`;
  if (op.clip) { ctx.beginPath(); ctx.rect(0, Y(op.clip[0]), ctx.canvas.width, Y(op.clip[1]) - Y(op.clip[0])); ctx.clip(); }
  ctx.textAlign = "left";
  ctx.textBaseline = op.anchor === "baseline" ? "alphabetic" : "middle";
  const x0 = op.align === "left" ? X(op.x) : X(op.x) - width / 2;
  const blue = (op.blue || "").trim(), bi = blue ? str.indexOf(t.upper ? blue.toUpperCase() : blue) : -1;
  const y = Y(op.y);
  if (bi < 0) { ctx.fillStyle = op.color || PAPER; ctx.fillText(str, x0, y); }
  else {
    const parts = [[str.slice(0, bi), op.color || PAPER], [str.slice(bi, bi + blue.length), op.accent || BLUE], [str.slice(bi + blue.length), op.color || PAPER]];
    let x = x0;
    for (const [p, c] of parts) { if (!p) continue; ctx.fillStyle = c; ctx.fillText(p, x, y); x += ctx.measureText(p).width; }
  }
  ctx.restore();
}

function chip(ctx, op, s, X, Y) {
  const t = TYPE.label, size = t.size * s, str = op.text.toUpperCase();
  ctx.save();
  setFont(ctx, t, size);
  const w = ctx.measureText(str).width - t.track * size + 32 * s, h = op.h * s;
  let x = "cx" in op ? X(op.cx) - w / 2 : "right" in op ? X(op.right) - w : X(op.x);
  x = clamp(x, X(96), Math.max(X(96), X(1824) - w));
  const y = Y(op.y), sc = op.scale || 1;
  ctx.globalAlpha = op.alpha;
  ctx.translate(x + w / 2, y + h / 2); ctx.scale(sc, sc); ctx.translate(-(x + w / 2), -(y + h / 2));
  rr(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = op.fill === "blue" ? op.color || BLUE : "rgba(20,17,24,.72)"; ctx.fill();
  if (op.fill !== "blue") { ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = op.fill === "blue" ? ON_BLUE : op.color || PAPER;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(str, x + 16 * s, y + h / 2 + 1);
  ctx.restore();
}

function cursor(ctx, op, s, X, Y) {
  const x = X(op.x), y = Y(op.y), k = s * (op.scale || 1);
  ctx.save();
  if (op.ripple) { ctx.strokeStyle = `rgba(120,200,255,${op.ripple[1]})`; ctx.lineWidth = 2 * s; ctx.beginPath(); ctx.arc(x, y, op.ripple[0] * s, 0, Math.PI * 2); ctx.stroke(); }
  ctx.globalAlpha = op.alpha;
  ctx.translate(x, y); ctx.scale(k, k);
  const p = new Path2D("M0 0 L0 22 L5.6 16.8 L9.2 25.4 L12.6 24 L9 15.6 L16 15.6 Z");
  ctx.shadowColor = "rgba(0,0,0,.3)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
  ctx.fillStyle = PAPER; ctx.fill(p);
  ctx.shadowColor = "transparent"; ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.stroke(p);
  ctx.restore();
}

/** Which graphic's box is under a viewer point (design px), for dragging its position. */
export function hitGraphic(project, f, px, py) {
  const hits = graphicsAt(project, f).reverse();
  for (const { g, lf } of hits) {
    if (g.template === "callout") {
      const [x, y, w, h] = g.rect;
      if (px >= x - 24 && px <= x + w + 24 && py >= y - 24 && py <= y + h + 24) return g;
      continue;
    }
    for (const op of stateAt(g, lf)) {
      if (op.w && op.h && px >= op.x && px <= op.x + op.w && py >= op.y && py <= op.y + op.h) return g;
      if (op.op === "text" && Math.abs(py - op.y) < (TYPE[op.token].lh || 40)) return g;
    }
  }
  return null;
}
