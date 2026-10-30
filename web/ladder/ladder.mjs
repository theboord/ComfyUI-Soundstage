// Soundstage preview ladder: compare one shot across stages on one picture.
//   3-way (default): Clay (or Color / Wire / Frame) | Draft | Final, with two handles you drag on the picture.
//   A/B: any two stages as a wipe, side by side, or a fade.
// Every layer is drawn the way the generators saw it: the stage render centre-cropped to the render's own aspect
// (the same crop the router uses to fit a guide to the model's size), at the same moment of the shot. So the layers
// line up while you drag; what moves between them is only what the model changed.

export const RUNG_NAMES = ["Wire", "Clay", "Look", "Draft", "Final"];
const STAGES = [["wire", "Wire"], ["clay", "Clay"], ["color", "Color"], ["look", "Frame"], ["draft", "Draft"], ["final", "Final"]];
const RUNG = { look: 2, draft: 3, final: 4 };
const LIVE = new Set(["wire", "clay", "color"]);
const YELLOW = "#f2ff59";
const FONT = "'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";

const name = (id) => STAGES.find((s) => s[0] === id)?.[1] || id;

export class LadderViewer {
  /**
   * @param {HTMLElement} container
   * @param {import("../stage/stage.mjs").Stage} stage
   */
  constructor(container, stage) {
    this.stage = stage;
    this.fidelity = 1; // the old single slider (0..4); still honoured in A/B modes
    this.frame = 0;
    this.mode = "three";
    this.sources = { 2: null, 3: null, 4: null }; // Look image, Draft video, Final video
    // 3-way: left / middle / right. null = automatic (the best render that exists).
    this.a = "clay"; this.m = null; this.b = null;
    this.cuts = [1 / 3, 2 / 3];   // the two 3-way handles
    this.split = 0.5;             // the A/B handle (and the 3-way handle when only two layers exist)
    if (!document.getElementById("ss-ladder-css")) {
      const st = document.createElement("style");
      st.id = "ss-ladder-css";
      st.textContent = `.ss-lcmp{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:0 0 8px;font-size:12px}
.ss-lcmp .grp{display:inline-flex;gap:4px;align-items:center}.ss-lcmp .lab{opacity:.7;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:11px}
.ss-lcmp button{font:inherit;font-size:12px;border-radius:999px;padding:3px 10px;cursor:pointer;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14)}
.ss-lcmp button:disabled{opacity:.35;cursor:default}.ss-lcmp .sep{width:1px;height:18px;background:rgba(255,255,255,.14)}
.ss-ladder:not([hidden]){display:flex;flex-direction:column;align-self:stretch;width:100%;height:100%;min-height:0;min-width:0}
.ss-ladder > *{flex:none}.ss-ladder > canvas.ss-lcv{flex:1 1 auto;min-height:0;width:100%;height:100%;object-fit:contain}`;
      document.head.append(st);
    }
    this.bar = document.createElement("div");
    this.bar.className = "ss-lcmp";
    this.bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    container.appendChild(this.bar);

    this.canvas = document.createElement("canvas");
    this.canvas.width = 960;
    this.canvas.height = 512;
    this.canvas.className = "ss-lcv";   // fills the view; the picture is letterboxed inside (object-fit: contain)
    this.canvas.style.cssText = "display:block;border-radius:6px;background:#0d1117;cursor:ew-resize;touch-action:none";
    this.ctx = this.canvas.getContext("2d");
    container.appendChild(this.canvas);

    // Drag on the picture: the nearest handle follows (a click jumps it there).
    let drag = -1;
    const fx = (e) => {   // x across the drawn picture, not the letterboxed element
      const r = this.canvas.getBoundingClientRect();
      const pw = Math.min(r.width, r.height * (this.canvas.width / this.canvas.height) || r.width);
      return Math.min(1, Math.max(0, (e.clientX - r.left - (r.width - pw) / 2) / pw));
    };
    const move = (x) => {
      if (this.mode === "three" && this._layers().length === 3) {
        const gap = 0.02;
        if (drag === 0) this.cuts[0] = Math.min(x, this.cuts[1] - gap);
        else this.cuts[1] = Math.max(x, this.cuts[0] + gap);
      } else this.split = x;
      this.draw();
    };
    this.canvas.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const x = fx(e);
      drag = this.mode === "three" && this._layers().length === 3
        ? (Math.abs(x - this.cuts[0]) <= Math.abs(x - this.cuts[1]) ? 0 : 1) : 0;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      move(x);
    });
    this.canvas.addEventListener("pointermove", (e) => { if (drag >= 0) { e.stopPropagation(); move(fx(e)); } });
    const end = () => { drag = -1; };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this._drawBar();
  }

  _has(id) {
    const r = RUNG[id];
    return r == null ? true : this.available(r);
  }

  /** The renders that exist, best first. */
  _renders() { return ["final", "draft", "look"].filter((id) => this._has(id)); }

  /** 3-way layers, left to right: the chosen left stage, then the renders (or the stage's own colour pass). */
  _layers() {
    const A = this.a && this._has(this.a) ? this.a : "clay";
    const pool = this._renders().filter((id) => id !== A);
    const B = this.b && this._has(this.b) && this.b !== A ? this.b : pool[0] || (A === "color" ? "clay" : "color");
    const M = this.m && this._has(this.m) && this.m !== A && this.m !== B ? this.m
      : this.m === "none" ? null : pool.filter((id) => id !== B && STAGES.findIndex((s) => s[0] === id) < STAGES.findIndex((s) => s[0] === B))[0] || null;
    return M ? [A, M, B] : [A, B];
  }

  /** A/B: B defaults to the best render that exists. */
  _bestB() { return this._renders()[0] || "color"; }

  _drawBar() {
    if (!this.bar) return;
    const chip = (label, on, enabled, title, click) => {
      const btn = Object.assign(document.createElement("button"), { type: "button", textContent: label, title });
      btn.disabled = !enabled;
      btn.setAttribute("aria-pressed", String(!!on));
      // Inline: the App theme styles every button.
      if (on) btn.style.cssText = `background:${YELLOW} !important;color:#111 !important;border-color:${YELLOW} !important;font-weight:650`;
      btn.addEventListener("click", click);
      return btn;
    };
    const group = (lab, ids, current, set) => {
      const g = document.createElement("span");
      g.className = "grp";
      g.append(Object.assign(document.createElement("span"), { className: "lab", textContent: lab }));
      for (const id of ids) {
        const ok = this._has(id);
        g.append(chip(name(id), current === id, ok, ok ? `${lab}: ${name(id)}` : `${name(id)} not rendered yet`,
          () => { set(id); this._drawBar(); this.draw(); }));
      }
      return g;
    };
    const parts = [];
    if (this.mode === "three") {
      const [A, M, B] = this._layers().length === 3 ? this._layers() : [this._layers()[0], null, this._layers()[1]];
      parts.push(group("Left", ["clay", "color", "wire", "look"], A, (id) => (this.a = id)));
      parts.push(group("Middle", ["look", "draft"], M, (id) => (this.m = this.m === id ? "none" : id)));
      parts.push(group("Right", ["draft", "final"], B, (id) => (this.b = id)));
    } else {
      const B = this.b && this._has(this.b) ? this.b : this._bestB();
      parts.push(group("A", STAGES.map((s) => s[0]), this.a, (id) => (this.a = id)));
      parts.push(group("vs B", STAGES.map((s) => s[0]), B, (id) => (this.b = id)));
    }
    parts.push(Object.assign(document.createElement("span"), { className: "sep" }));
    const modes = document.createElement("span");
    modes.className = "grp";
    for (const [m, label] of [["three", "3-way"], ["wipe", "Wipe"], ["side", "Side by side"], ["fade", "Fade"]]) {
      modes.append(chip(label, this.mode === m, true, label, () => { this.mode = m; this._drawBar(); this.draw(); }));
    }
    parts.push(modes);
    this.bar.replaceChildren(...parts);
  }

  /** Register a finished rung result. kind: "image" or "video"; url: a /view URL. */
  setSource(rung, kind, url) {
    if (kind === "image") {
      const img = new Image();
      img.onload = () => { this._drawBar(); this.draw(); };
      img.src = url;
      this.sources[rung] = { kind, el: img, url };
    } else {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.playsInline = true;
      v.crossOrigin = "anonymous";
      v.addEventListener("seeked", () => this.draw());
      v.addEventListener("loadeddata", () => { this.seek(); this._drawBar(); this.draw(); }); // at frame 0 there is no seek, so draw now
      v.src = url;
      this.sources[rung] = { kind, el: v, url };
    }
  }

  /** Forget a rung's media (a shot without that render yet), so another shot's video never shows in its place. */
  clearSource(rung) {
    const s = this.sources[rung];
    if (s?.kind === "video") { try { s.el.pause(); s.el.removeAttribute("src"); s.el.load(); } catch { /* gone */ } }
    delete this.sources[rung];
    this._drawBar();
    this.draw();
  }

  available(rung) {
    if (rung <= 1) return true;
    const s = this.sources[rung];
    if (!s) return false;
    return s.kind === "image" ? s.el.complete && s.el.naturalWidth > 0 : s.el.readyState >= 2;
  }

  setFidelity(f) {
    // The old single slider. In 3-way the layers follow the renders on their own, so just refresh.
    this.fidelity = Math.min(RUNG_NAMES.length - 1, Math.max(0, f));
    if (this.mode !== "three") {
      const ids = ["wire", "clay", "look", "draft", "final"];
      const lo = Math.floor(this.fidelity), hi = Math.min(4, lo + 1);
      this.a = ids[lo]; this.b = ids[hi]; this.split = 1 - (this.fidelity - lo || 0.5);
    }
    this._drawBar();
    this.draw();
  }

  setFrame(frame) {
    this.frame = Math.max(0, Math.round(frame));
    this.seek();
    this.draw();
  }

  seek() {
    const fps = this.stage.state?.shot?.fps || 24;
    for (const r of [3, 4]) {
      const s = this.sources[r];
      if (s?.kind === "video" && s.el.readyState >= 1) {
        const t = Math.min(this.frame / fps, Math.max(0, s.el.duration - 1 / fps));
        if (Math.abs(s.el.currentTime - t) > 0.5 / fps) s.el.currentTime = t;
      }
    }
  }

  /** The picture's size: the best render's own aspect (what the model actually made), else the stage frame. */
  _size() {
    for (const r of [4, 3, 2]) {
      if (!this.available(r)) continue;
      const el = this.sources[r].el;
      const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
      if (w && h) { const W = Math.min(1280, w); return [W, Math.round((W * h) / w)]; }
    }
    return [this.stage.fw, this.stage.fh];
  }

  /** Draw a stage into ctx's rect with a centre crop (the router's fit), so every layer shares one framing. */
  _drawStage(id, ctx, x = 0, y = 0, w = this.canvas.width, h = this.canvas.height) {
    let el, sw, sh;
    if (LIVE.has(id)) {
      el = this.stage.renderFrameTo(id, this.frame);
      sw = el.width; sh = el.height;
    } else {
      const rung = RUNG[id];
      if (!this.available(rung)) {
        ctx.fillStyle = "#11151b"; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#7d8694"; ctx.font = `20px ${FONT}`; ctx.textAlign = "center";
        ctx.fillText(`${name(id)} not rendered yet`, x + w / 2, y + h / 2);
        ctx.textAlign = "start";
        return false;
      }
      el = this.sources[rung].el;
      sw = el.videoWidth || el.naturalWidth; sh = el.videoHeight || el.naturalHeight;
    }
    if (!sw || !sh) return false;
    const s = Math.max(w / sw, h / sh), cw = w / s, ch = h / s;
    ctx.drawImage(el, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
    return true;
  }

  _label(txt, x, align, hot, clip) {
    const ctx = this.ctx;
    ctx.save();
    if (clip) { ctx.beginPath(); ctx.rect(clip[0], 0, clip[1] - clip[0], this.canvas.height); ctx.clip(); }
    ctx.font = `600 20px ${FONT}`;
    ctx.textAlign = align;
    const w = ctx.measureText(txt).width + 20;
    const left = align === "left" ? x : align === "right" ? x - w : x - w / 2;
    ctx.fillStyle = hot ? YELLOW : "rgba(0,0,0,0.6)";
    ctx.beginPath(); (ctx.roundRect ? ctx.roundRect(left, 12, w, 32, 16) : ctx.rect(left, 12, w, 32)); ctx.fill();
    ctx.fillStyle = hot ? "#111" : "#fff";
    ctx.fillText(txt, align === "left" ? x + 10 : align === "right" ? x - 10 : x, 35);
    ctx.restore();
  }

  _handle(sx) {
    const ctx = this.ctx, H = this.canvas.height;
    ctx.fillStyle = YELLOW; ctx.fillRect(sx - 1.5, 0, 3, H);
    ctx.beginPath(); ctx.arc(sx, H / 2, 20, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#111"; ctx.beginPath();
    ctx.moveTo(sx - 5, H / 2 - 7); ctx.lineTo(sx - 12, H / 2); ctx.lineTo(sx - 5, H / 2 + 7);
    ctx.moveTo(sx + 5, H / 2 - 7); ctx.lineTo(sx + 12, H / 2); ctx.lineTo(sx + 5, H / 2 + 7); ctx.fill();
  }

  draw() {
    const [cw, ch] = this._size();
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const { width: W, height: H } = this.canvas;
    const ctx = this.ctx;
    ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, W, H);

    if (this.mode === "three") {
      const L = this._layers();
      const xs = L.length === 3 ? [0, this.cuts[0], this.cuts[1], 1] : [0, this.split, 1];
      const px = xs.map((f) => Math.round(f * W));
      L.forEach((id, i) => {
        ctx.save(); ctx.beginPath(); ctx.rect(px[i], 0, px[i + 1] - px[i], H); ctx.clip();
        this._drawStage(id, ctx);
        ctx.restore();
      });
      L.forEach((id, i) => {
        const a = px[i], b = px[i + 1];
        if (b - a < 60) return;
        const first = i === 0, last = i === L.length - 1;
        this._label(name(id), first ? a + 10 : last ? b - 10 : (a + b) / 2, first ? "left" : last ? "right" : "center", first, [a, b]);
      });
      for (const x of px.slice(1, -1)) this._handle(x);
      return;
    }
    const A = this.a, B = this.b && this._has(this.b) ? this.b : this._bestB();
    if (this.mode === "side") {
      const w = W / 2, h = H / 2, y = H / 4;
      this._drawStage(A, ctx, 0, y, w, h);
      this._drawStage(B, ctx, w, y, w, h);
      this._label(name(A), 10, "left", true); this._label(name(B), W - 10, "right");
      return;
    }
    if (this.mode === "fade") {
      this._drawStage(A, ctx);
      ctx.save(); ctx.globalAlpha = this.split; this._drawStage(B, ctx); ctx.restore();
      this._label(`${name(A)} → ${name(B)} · ${Math.round(this.split * 100)}%`, 10, "left", true);
      return;
    }
    // Wipe: A on the left of the handle, B on the right.
    const sx = Math.round(W * this.split);
    this._drawStage(A, ctx);
    ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); this._drawStage(B, ctx); ctx.restore();
    this._handle(sx);
    this._label(name(A), 10, "left", true); this._label(name(B), W - 10, "right");
  }
}
