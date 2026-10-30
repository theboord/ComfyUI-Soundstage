// Visual camera gear: little drawings for camera bodies, lens character, focal length (a field-of-view wedge drawn
// from the real angle of view) and aperture (an iris that opens with the f-stop), plus a draggable 3D sun dome.
// Original SVG/canvas drawings (MIT, part of Soundstage). Colours follow the theme via currentColor.

const SVG = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const FILL = "fill=\"currentColor\" fill-opacity=\".16\"";

/** Camera body silhouette by look id (cinema digital, large format, film with magazine, small film, phone, …). */
export function bodyIcon(id = "auto") {
  const k = String(id);
  if (k === "auto") return SVG(56, 32, `<rect x="14" y="10" width="22" height="14" rx="3" ${FILL}/><text x="25" y="20.5" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">A</text>`);
  if (/smartphone/.test(k)) return SVG(56, 32, `<rect x="21" y="4" width="14" height="24" rx="3" ${FILL}/><circle cx="31" cy="8" r="1.4"/>`);
  if (/action_cam/.test(k)) return SVG(56, 32, `<rect x="17" y="9" width="20" height="15" rx="2" ${FILL}/><circle cx="31" cy="16.5" r="4.5"/>`);
  if (/drone/.test(k)) return SVG(56, 32, `<path d="M16 9 L40 23 M40 9 L16 23"/><circle cx="16" cy="9" r="4" ${FILL}/><circle cx="40" cy="9" r="4" ${FILL}/><circle cx="16" cy="23" r="4" ${FILL}/><circle cx="40" cy="23" r="4" ${FILL}/><rect x="24" y="13" width="8" height="6" rx="2" ${FILL}/>`);
  if (/cctv/.test(k)) return SVG(56, 32, `<path d="M14 8 H42"/><path d="M18 8 A10 10 0 0 0 38 8" ${FILL}/><circle cx="28" cy="13" r="3"/>`);
  if (/bodycam/.test(k)) return SVG(56, 32, `<rect x="19" y="6" width="18" height="21" rx="3" ${FILL}/><circle cx="28" cy="14" r="4"/><path d="M23 23 H33"/>`);
  if (/camcorder|vhs|dv_|broadcast|early_hd/.test(k)) return SVG(56, 32, `<rect x="12" y="11" width="26" height="12" rx="3" ${FILL}/><path d="M38 14 L46 11 V23 L38 20"/><path d="M16 11 V7 H32 V11"/>`);
  const film = /film_|imax|technicolor|silent|super8|bolex/.test(k);
  const small = /super8|16mm|super16|bolex|silent/.test(k);
  const big = /imax|65|alexa_65|large|technicolor/.test(k);
  const w = big ? 26 : small ? 18 : 22, x = 12;
  let s = `<rect x="${x}" y="${small ? 13 : 12}" width="${w}" height="${small ? 11 : 13}" rx="2" ${FILL}/>`;
  s += `<rect x="${x + w}" y="${small ? 15 : 14.5}" width="${small ? 7 : 9}" height="${small ? 7 : 8}" rx="1.5"/>`;   // lens
  if (film) s += `<circle cx="${x + 6}" cy="${small ? 9 : 7}" r="${small ? 3.6 : 4.6}"/><circle cx="${x + w - 6}" cy="${small ? 9 : 7}" r="${small ? 3.6 : 4.6}"/>`; // magazine
  else s += `<path d="M${x + 4} 12 V8 H${x + w - 6} V12"/>`;                                                          // top handle
  if (small) s += `<path d="M${x + 6} 24 L${x + 4} 29"/>`;                                                              // pistol grip
  return SVG(56, 32, s);
}

/** Lens barrel by character: anamorphic oval front, vintage brass rings, macro/probe length, tilt-shift offset, fisheye dome. */
export function lensIcon(id = "auto") {
  const k = String(id);
  if (k === "auto") return SVG(56, 32, `<rect x="16" y="10" width="22" height="12" rx="2" ${FILL}/><text x="27" y="19.5" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">A</text>`);
  if (/fisheye/.test(k)) return SVG(56, 32, `<rect x="14" y="11" width="16" height="10" rx="1.5" ${FILL}/><path d="M30 8 A9 9 0 0 1 30 24" ${FILL}/>`);
  if (/probe/.test(k)) return SVG(56, 32, `<rect x="10" y="12" width="10" height="9" rx="1.5" ${FILL}/><rect x="20" y="14.5" width="26" height="4" rx="1"/>`);
  if (/tilt/.test(k)) return SVG(56, 32, `<rect x="12" y="11" width="12" height="11" rx="1.5" ${FILL}/><rect x="25" y="8" width="14" height="11" rx="1.5" transform="rotate(-10 32 13)" ${FILL}/>`);
  if (/split/.test(k)) return SVG(56, 32, `<rect x="12" y="10" width="20" height="12" rx="2" ${FILL}/><path d="M33 10 V22 M33 10 A8 6 0 0 1 33 22"/>`);
  const long = /macro|long_tele|zoom/.test(k), ana = /anamorphic|panavision/.test(k), vint = /vintage|helios|petzval|k35|halation|soft/.test(k);
  const len = long ? 30 : 22, x = 12;
  let s = `<rect x="${x}" y="10" width="${len}" height="12" rx="2" ${FILL}/>`;
  for (const t of vint ? [0.3, 0.55, 0.8] : [0.45]) s += `<path d="M${x + len * t} 10 V22"${vint ? ' stroke-dasharray="1.6 1.6"' : ""}/>`;
  s += ana ? `<ellipse cx="${x + len + 2}" cy="16" rx="2.5" ry="7" ${FILL}/>` : `<rect x="${x + len}" y="9" width="3" height="14" rx="1"/>`;
  return SVG(56, 32, s);
}

/** Field-of-view wedge for a focal length on full-frame (36 mm wide): wide lenses fan out, long ones narrow. */
export function fovIcon(mm) {
  const half = Math.atan(36 / 2 / Math.max(8, +mm || 35));
  const L = 40, x0 = 10, y0 = 16;
  const dy = Math.min(15, Math.tan(half) * L);
  return SVG(56, 32, `<path d="M${x0} ${y0} L${x0 + L} ${y0 - dy} L${x0 + L} ${y0 + dy} Z" ${FILL}/><rect x="${x0 - 7}" y="${y0 - 4}" width="8" height="8" rx="1.5"/>`);
}

/** Aperture iris: six blades, the opening shrinks as the f-number grows. */
export function irisIcon(f = "auto") {
  if (String(f) === "auto") return SVG(32, 32, `<circle cx="16" cy="16" r="11" ${FILL}/><text x="16" y="19.5" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">A</text>`);
  const n = parseFloat(String(f).replace(/^f/, "").replace("_", ".")) || 2.8;
  const r = Math.max(2, 10 * Math.sqrt(1.4 / n));
  const pts = Array.from({ length: 6 }, (_, i) => { const a = (i / 6) * Math.PI * 2 + 0.3; return `${(16 + r * Math.cos(a)).toFixed(1)},${(16 + r * Math.sin(a)).toFixed(1)}`; });
  let blades = "";
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; blades += `<path d="M${16 + r * Math.cos(a)} ${16 + r * Math.sin(a)} L${16 + 12 * Math.cos(a + 0.9)} ${16 + 12 * Math.sin(a + 0.9)}" stroke-opacity=".55"/>`; }
  return SVG(32, 32, `<circle cx="16" cy="16" r="12" ${FILL}/>${blades}<polygon points="${pts.join(" ")}" fill="#000" fill-opacity=".55"/>`);
}

export const GEAR_CSS = `
.ss-gear { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:8px; }
@media (max-width: 720px) { .ss-gear { grid-template-columns:repeat(2, minmax(0,1fr)); } }
.ss-gear .col { display:flex; flex-direction:column; gap:5px; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:6px; max-height:260px; overflow:auto; }
.ss-gear .col h5 { margin:2px 4px 4px; font-size:12px; font-weight:600; color:var(--ss-text,#f0efed); text-align:center; }
.ss-stage .ss-gear button.gear { display:flex !important; align-items:center; justify-content:space-between; gap:6px; border-radius:10px !important;
  padding:4px 6px 4px 9px !important; min-height:38px; background:rgba(255,255,255,.04) !important; color:var(--ss-muted,#a9a3ad) !important; text-align:left; }
.ss-stage .ss-gear button.gear span { font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
.ss-stage .ss-gear button.gear svg { flex:none; color:#b9b3be; }
.ss-stage .ss-gear button.gear[aria-pressed="true"] { border-color:var(--ss-text,#f0efed) !important; color:var(--ss-text,#f0efed) !important; background:rgba(255,255,255,.08) !important; }
.ss-stage .ss-gear button.gear[aria-pressed="true"] svg { color:var(--ss-accent,#F2FF59); }
.ss-lenscards { display:flex; gap:4px; flex-wrap:wrap; }
.ss-stage .ss-lenscards button { display:flex !important; flex-direction:column !important; align-items:center; gap:0 !important; padding:2px 6px !important; border-radius:9px !important; min-width:44px; }
.ss-stage .ss-lenscards button svg { width:40px; height:22px; color:#b9b3be; }
.ss-stage .ss-lenscards button span { font-size:10px; line-height:1; }
.ss-stage .ss-lenscards button[aria-pressed="true"] { border-color:var(--ss-accent,#F2FF59) !important; }
.ss-stage .ss-lenscards button[aria-pressed="true"] svg { color:var(--ss-accent,#F2FF59); }
.ss-sundome { width:92px; height:92px; cursor:grab; touch-action:none; border-radius:12px; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); }
`;

export function injectGearCss() {
  if (document.getElementById("ss-gear-css")) return;
  const s = document.createElement("style");
  s.id = "ss-gear-css";
  s.textContent = GEAR_CSS;
  document.head.append(s);
}

/** Lens focal-length cards (14…135 mm) with field-of-view icons; onPick(mm). Returns {el, set(mm)}. */
export function lensCards(onPick, list = [14, 18, 24, 35, 50, 85, 135]) {
  injectGearCss();
  const el = document.createElement("div");
  el.className = "ss-lenscards";
  const btns = list.map((mm) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = `${mm} mm: ${(2 * Math.atan(18 / mm) * 180 / Math.PI).toFixed(0)}° horizontal field of view`;
    b.innerHTML = fovIcon(mm) + `<span>${mm}</span>`;
    b.dataset.mm = mm;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => onPick(mm));
    el.append(b);
    return b;
  });
  const set = (mm) => {
    const near = list.reduce((a, b) => (Math.abs(b - mm) < Math.abs(a - mm) ? b : a), list[0]);
    for (const b of btns) b.setAttribute("aria-pressed", String(+b.dataset.mm === near && Math.abs(near - mm) <= Math.max(2, near * 0.12)));
  };
  return { el, set };
}

/**
 * A 3D sun dome: the ground is an ellipse seen from above at an angle, N marked, the sun is a glowing ball on the sky
 * dome. Drag around to change its direction (azimuth), drag toward the centre to raise it (elevation). onChange(az, el).
 */
export function sunDome(onChange) {
  injectGearCss();
  const c = document.createElement("canvas");
  c.className = "ss-sundome";
  c.title = "Sun: drag around the dome to set its direction, toward the middle to raise it";
  const dpr = window.devicePixelRatio || 1;
  c.width = 92 * dpr; c.height = 92 * dpr;
  let az = 235, el = 18, north = 0;
  const C = 46, R = 36, tilt = 0.55;                 // ellipse squash = viewing the dome from 33° above
  const proj = (azDeg, elDeg) => {
    const a = (azDeg - north) * Math.PI / 180, e = elDeg * Math.PI / 180;
    const x = Math.sin(a) * Math.cos(e) * R, z = Math.cos(a) * Math.cos(e) * R, y = Math.sin(e) * R;
    return [C + x, C + 6 + z * tilt - y * 0.85];
  };
  const draw = () => {
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, 92, 92);
    // ground disc + compass
    g.fillStyle = "rgba(255,255,255,.05)"; g.strokeStyle = "rgba(255,255,255,.25)"; g.lineWidth = 1;
    g.beginPath(); g.ellipse(C, C + 6, R, R * tilt, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    // dome outline
    g.strokeStyle = "rgba(255,255,255,.12)";
    g.beginPath(); g.ellipse(C, C + 6, R, R * 0.85, 0, Math.PI, 0); g.stroke();
    const [nx, ny] = proj(north, 0);
    g.fillStyle = "#b9b3be"; g.font = "600 9px ui-sans-serif, system-ui"; g.textAlign = "center"; g.textBaseline = "middle";
    const [lx, ly] = [C + (nx - C) * 1.18, C + 6 + (ny - C - 6) * 1.3];
    g.fillText("N", lx, ly);
    // sun path for this azimuth (horizon → zenith), sun position, ray to the centre and its shadow direction
    g.strokeStyle = "rgba(242,255,89,.25)"; g.setLineDash([2, 3]);
    g.beginPath();
    for (let e = 0; e <= 90; e += 6) { const [x, y] = proj(az, e); e ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.setLineDash([]);
    const [sx, sy] = proj(az, el);
    const [gx, gy] = proj(az + 180, 0);
    g.strokeStyle = "rgba(0,0,0,.45)"; g.lineWidth = 3;
    g.beginPath(); g.moveTo(C, C + 6); g.lineTo(C + (gx - C) * (1 - el / 90) * 0.8, C + 6 + (gy - C - 6) * (1 - el / 90) * 0.8); g.stroke();
    g.fillStyle = "#d8d3dc"; g.beginPath(); g.arc(C, C + 6, 2.5, 0, Math.PI * 2); g.fill();     // the set
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 11);
    glow.addColorStop(0, "rgba(255,240,170,1)"); glow.addColorStop(0.45, "rgba(242,255,89,.9)"); glow.addColorStop(1, "rgba(242,255,89,0)");
    g.fillStyle = glow; g.beginPath(); g.arc(sx, sy, 11, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#b9b3be"; g.font = "500 9px ui-sans-serif, system-ui"; g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillText(`${Math.round(el)}°`, 4, 88);
  };
  const fromPointer = (e) => {
    const r = c.getBoundingClientRect();
    const px = (e.clientX - r.left) * (92 / r.width), py = (e.clientY - r.top) * (92 / r.height);
    // The sun goes exactly where you point: pick the (direction, height) whose drawing is closest to the cursor.
    let best = null;
    for (let a = 0; a < 360; a += 4) for (let h = 0; h <= 88; h += 2) {
      const [x, y] = proj(a + north, h), d = (x - px) ** 2 + (y - py) ** 2;
      if (!best || d < best.d) best = { d, a: a + north, h };
    }
    az = ((best.a % 360) + 360) % 360;
    el = best.h;
    draw();
    onChange?.(Math.round(az), Math.round(el));
  };
  let drag = false;
  c.addEventListener("pointerdown", (e) => { e.stopPropagation(); drag = true; c.setPointerCapture(e.pointerId); fromPointer(e); });
  c.addEventListener("pointermove", (e) => { if (drag) fromPointer(e); });
  c.addEventListener("pointerup", () => { drag = false; });
  draw();
  return { el: c, set(a, e, n = north) { az = a; el = e; north = n; draw(); } };
}
