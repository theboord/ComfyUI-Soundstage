// Soundstage grade: the browser half of the colour pipeline. No DOM, node-tested.
//   - ASC CDL normalising and the text writers (.cdl, .ccc, .cube, EDL *ASC_SOP lines), byte for byte the same as
//     soundstage/grade/cdl.py and package.py (tests/test_grade.py runs both and compares).
//   - gradeFiles(project, base): the grade files of the NLE package (exporters.mjs exportAll adds them).
//   - checkCut(rows): grade continuity across cuts, the same numbers as soundstage/grade/continuity.py (the Coach's
//     "1G is 0.4 stops warmer than 1H").
// The pixel work (stats, shot matching, Steal the look) runs on the server in numpy: POST /soundstage/grade/*.

export const IDENTITY = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 };
const BOUNDS = { slope: [0.25, 4], offset: [-0.5, 0.5], power: [0.25, 4], sat: [0, 3] };

const num = (v, d) => {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return d;
  const f = Number(v);
  return Number.isFinite(f) ? f : d;
};
const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

export function normalizeCdl(c) {
  c = c && typeof c === "object" && !Array.isArray(c) ? c : {};
  const out = {};
  for (const k of ["slope", "offset", "power"]) {
    const d = IDENTITY[k][0];
    let v = c[k];
    if (!Array.isArray(v)) v = v != null ? [v, v, v] : [d, d, d];
    v = [...v, d, d, d].slice(0, 3);
    out[k] = v.map((x) => clampTo(num(x, d), BOUNDS[k]));
  }
  out.sat = clampTo(num(c.sat, 1), BOUNDS.sat);
  return out;
}

export function isIdentity(c, eps = 1e-6) {
  const n = normalizeCdl(c);
  return ["slope", "offset", "power"].every((k) => n[k].every((x, i) => Math.abs(x - IDENTITY[k][i]) < eps)) && Math.abs(n.sat - 1) < eps;
}

export function normalizeCurve(curve) {
  if (!Array.isArray(curve) || curve.length !== 17) return null;
  let prev = 0;
  return curve.map((v) => {
    const f = Math.min(1, Math.max(0, num(v, 0)));
    prev = Math.max(prev, f);
    return prev;
  });
}

const fixed = (v, nd) => { const s = Number(v).toFixed(nd); return /^-[0.]+$/.test(s) ? s.slice(1) : s; };
const f4 = (v) => fixed(v, 4);
const f6 = (v) => fixed(v, 6);
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cc(id, cdl, desc = "", ind = "  ") {
  const c = normalizeCdl(cdl), i2 = ind + "  ", i3 = ind + "    ";
  const out = [`${ind}<ColorCorrection id="${xml(id)}">`];
  if (desc) out.push(`${i2}<Description>${xml(desc)}</Description>`);
  out.push(`${i2}<SOPNode>`,
    `${i3}<Slope>${c.slope.map(f4).join(" ")}</Slope>`,
    `${i3}<Offset>${c.offset.map(f4).join(" ")}</Offset>`,
    `${i3}<Power>${c.power.map(f4).join(" ")}</Power>`,
    `${i2}</SOPNode>`,
    `${i2}<SATNode>`, `${i3}<Saturation>${f4(c.sat)}</Saturation>`, `${i2}</SATNode>`,
    `${ind}</ColorCorrection>`);
  return out;
}

export function cdlXml(id, cdl, desc = "") {
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<ColorDecisionList xmlns="urn:ASC:CDL:v1.01">', "  <ColorDecision>",
    ...cc(id, cdl, desc, "    "), "  </ColorDecision>", "</ColorDecisionList>", ""].join("\n");
}

export function cccXml(items) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">'];
  for (const it of items) out.push(...cc(it.id, it.cdl, it.desc || ""));
  return [...out, "</ColorCorrectionCollection>", ""].join("\n");
}

/** The two EDL comment lines Avid and Resolve read a CDL from. */
export function edlSop(cdl) {
  const c = normalizeCdl(cdl);
  return [`*ASC_SOP (${c.slope.map(f4).join(" ")})(${c.offset.map(f4).join(" ")})(${c.power.map(f4).join(" ")})`, `*ASC_SAT ${f4(c.sat)}`];
}

/** One pixel through a CDL (display-encoded Rec.709, ASC CDL v1.2 order). */
export function cdlPixel(c, r, g, b) {
  const v = [r, g, b].map((x, k) => {
    let t = x * c.slope[k] + c.offset[k];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t ** c.power[k];
  });
  const y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  return v.map((x) => Math.min(1, Math.max(0, y + c.sat * (x - y))));
}

function curveAt(curve, v) {
  const x = v * 16, i = Math.min(15, Math.trunc(x)), u = x - i;
  return curve[i] + (curve[i + 1] - curve[i]) * u;
}

/** A 33^3 .cube (Rec.709 in and out): the CDLs in order, then the tone curve on each channel. */
export function cubeText(cdls = null, curve = null, title = "Soundstage grade", size = 33) {
  const cs = (Array.isArray(cdls) ? cdls : [cdls]).map(normalizeCdl);
  if (!cs.length) cs.push(normalizeCdl(null));
  const cv = normalizeCurve(curve), n = Math.trunc(size), d = n - 1;
  const out = [`TITLE "${String(title).replace(/"/g, "")}"`,
    "# Soundstage: ASC CDL (Rec.709 display-encoded) then tone curve. Input and output Rec.709 / sRGB.",
    `LUT_3D_SIZE ${n}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let bi = 0; bi < n; bi++) for (let gi = 0; gi < n; gi++) for (let ri = 0; ri < n; ri++) {
    let px = [ri / d, gi / d, bi / d];
    for (const c of cs) px = cdlPixel(c, ...px);
    if (cv) px = px.map((x) => curveAt(cv, x));
    out.push(`${f6(px[0])} ${f6(px[1])} ${f6(px[2])}`);
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------- NLE package

export const clipId = (name) => String(name || "clip").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "clip";

export function shotGrade(shot) {
  const g = shot?.grade;
  return !g || typeof g !== "object" || Array.isArray(g) || isIdentity(g) ? null : normalizeCdl(g);
}

export function showLook(project) {
  const s = project?.colour && typeof project.colour === "object" ? project.colour.show : null;
  if (!s || typeof s !== "object") return null;
  const cdl = normalizeCdl(s.cdl), curve = normalizeCurve(s.curve);
  if (isIdentity(cdl) && !curve) return null;
  return { cdl, curve, name: String(s.name || "Show look") };
}

/** The grade files of the NLE package (soundstage/grade/package.py grade_files). {} when nothing is graded. */
export function gradeFiles(project, base) {
  const show = showLook(project);
  const graded = [], seen = new Set();
  for (const s of project?.shots || []) {
    const g = shotGrade(s), id = clipId(s.name || s.id);
    if (!g || seen.has(id)) continue;
    seen.add(id);
    graded.push({ id, cdl: g, desc: String(s.grade?.note || "").slice(0, 200) });
  }
  if (!graded.length && !show) return {};
  const out = {};
  if (graded.length) {
    out[`${base}_grades.ccc`] = cccXml(graded);
    for (const it of graded) {
      out[`${base}_${it.id}.cdl`] = cdlXml(it.id, it.cdl, it.desc);
      out[`${base}_${it.id}.cube`] = cubeText([it.cdl, ...(show ? [show.cdl] : [])], show ? show.curve : null, `${it.id} grade`);
    }
  }
  if (show) {
    out[`${base}_show.cdl`] = cdlXml("show", show.cdl, show.name);
    out[`${base}_show.cube`] = cubeText([show.cdl], show.curve, show.name);
  }
  out["GRADE.txt"] = gradeReadme(base, graded, show);
  return out;
}

function gradeReadme(base, graded, show) {
  const lines = [`Soundstage grade: ${base}`, "",
    "Colour space: Rec.709 / sRGB display-encoded in and out (a Rec.709 timeline). The CDLs are ASC CDL v1.2",
    "(slope, offset, power, then saturation with Rec.709 luma weights); the .cube LUTs are 33x33x33.", ""];
  if (graded.length) {
    lines.push(`Per-clip grades (${graded.length}): shot matching to the scene's hero take, in OKLab.`,
      `  Avid Media Composer: the EDL carries *ASC_SOP / *ASC_SAT on each event; or import ${base}_grades.ccc.`,
      `  DaVinci Resolve: import the EDL with 'Use CDL from EDL', or Color > right-click a clip > Apply LUT > ${base}_<clip>.cube.`,
      `  Premiere Pro: Lumetri Color > Basic Correction > Input LUT > ${base}_<clip>.cube.`,
      "  Each clip's .cube already includes the show look after its own CDL; the .cdl/.ccc are the clip's CDL only.", "",
      ...graded.map((g) => `  ${g.id}`), "");
  }
  if (show) {
    lines.push(`Show look: ${show.name}` + (show.curve ? " (CDL + tone curve)" : " (CDL)"),
      `  ${base}_show.cube on an adjustment layer / timeline node, or ${base}_show.cdl where only a CDL fits`,
      show.curve ? "  (the .cdl cannot carry the tone curve)." : "", "");
  }
  lines.push("Order in a node tree: clip CDL -> show look. Do not stack a clip .cube on top of the show .cube: it already has it.");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------- continuity

export const THRESHOLDS = { exposure_ev: 0.33, warmth_ev: 0.25, tint_ev: 0.25 };
const WORDS = { exposure_ev: ["brighter", "darker"], warmth_ev: ["warmer", "cooler"], tint_ev: ["greener", "more magenta"] };
const r3 = (v) => Math.round(v * 1000) / 1000;

export function compareStats(a, b) {
  const out = {};
  for (const k of Object.keys(THRESHOLDS)) out[k] = r3(Number(a[k]) - Number(b[k]));
  out.delta_e = Math.round(100 * Math.hypot(a.L_mean - b.L_mean, a.a_mean - b.a_mean, a.b_mean - b.b_mean) * 100) / 100;
  return out;
}

const stops = (v) => { const s = Math.abs(v).toFixed(1); return `${s} stop${s === "1.0" ? "" : "s"}`; };
export const phrase = (a, b, key, d) => `${a} is ${stops(d)} ${d > 0 ? WORDS[key][0] : WORDS[key][1]} than ${b}`;

/** rows: the cut in order [{id, name, scene?, stats}]; one flag per cut inside a scene past a threshold. */
export function checkCut(rows, thresholds = {}) {
  const th = { ...THRESHOLDS, ...thresholds }, flags = [];
  for (let i = 1; i < (rows || []).length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    if (!prev.stats || !cur.stats || prev.id === cur.id) continue;
    if ((prev.scene || "") !== (cur.scene || "")) continue;
    const d = {};
    for (const k of Object.keys(th)) d[k] = Number(cur.stats[k]) - Number(prev.stats[k]);   // judged unrounded, as in Python
    const over = Object.keys(th).filter((k) => Math.abs(d[k]) >= th[k]);
    if (!over.length) continue;
    const rank = (k) => Math.abs(d[k]) / th[k];
    const worst = over.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    const text = [...over].sort((a, b) => rank(b) - rank(a))
      .map((k) => phrase(cur.name || cur.id, prev.name || prev.id, k, d[k])).join("; ");
    flags.push({ a: cur.id, b: prev.id, key: worst, text, deltas: compareStats(cur.stats, prev.stats) });
  }
  return flags;
}
