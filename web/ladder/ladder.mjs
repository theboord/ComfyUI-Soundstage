// Soundstage preview ladder viewer: scrub one shot across fidelity (Wire → Clay → Look →
// Draft → Final) and across time. Wire and Clay are rendered live from the 3D stage, so
// they always exist; Look, Draft and Final appear as each Run climbs the ladder.

export const RUNG_NAMES = ["Wire", "Clay", "Look", "Draft", "Final"];

export class LadderViewer {
  /**
   * @param {HTMLElement} container
   * @param {import("../stage/stage.mjs").Stage} stage
   */
  constructor(container, stage) {
    this.stage = stage;
    this.fidelity = 1; // 0..4, fractional = blend between neighbours (the old single slider; still honoured)
    this.frame = 0;
    this.mode = "wipe";
    this.sources = { 2: null, 3: null, 4: null }; // Look image, Draft video, Final video
    // A / B compare: any two stages, a split you drag on the picture.
    this.a = "clay"; this.b = null; this.split = 0.5;
    if (!document.getElementById("ss-ladder-css")) {
      const st = document.createElement("style");
      st.id = "ss-ladder-css";
      st.textContent = `.ss-lcmp{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:0 0 8px;font-size:12px}
.ss-lcmp .grp{display:inline-flex;gap:4px;align-items:center}.ss-lcmp .lab{opacity:.7;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:11px}
.ss-lcmp button{font:inherit;font-size:12px;border-radius:999px;padding:3px 10px;cursor:pointer;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14)}
.ss-lcmp button:disabled{opacity:.35;cursor:default}.ss-lcmp button.a{background:#f2ff59;color:#111;border-color:#f2ff59;font-weight:650}
.ss-lcmp button.b{background:#fff;color:#111;border-color:#fff;font-weight:650}.ss-lcmp .mode button[aria-pressed=true]{border-color:#f2ff59;color:#f2ff59}`;
      document.head.append(st);
    }
    this.bar = document.createElement("div");
    this.bar.className = "ss-lcmp";
    this.bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    container.appendChild(this.bar);

    this.canvas = document.createElement("canvas");
    this.canvas.width = 960;
    this.canvas.height = 512;
    this.canvas.style.cssText = "display:block;width:100%;height:auto;border-radius:6px;background:#0d1117;cursor:ew-resize";
    this.ctx = this.canvas.getContext("2d");
    container.appendChild(this.canvas);

    // Drag on the picture to move the split (wipe), or the mix (fade).
    let dragging = false;
    const fromPointer = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.draw();
    };
    this.canvas.addEventListener("pointerdown", (e) => { e.stopPropagation(); dragging = true; this.canvas.setPointerCapture(e.pointerId); fromPointer(e); });
    this.canvas.addEventListener("pointermove", (e) => { if (dragging) { e.stopPropagation(); fromPointer(e); } });
    this.canvas.addEventListener("pointerup", () => (dragging = false));
    this._drawBar();
  }

  /** The stages you can compare, in order; Look is the painted first frame. */
  _stages() {
    return [["wire", "Wire"], ["clay", "Clay"], ["color", "Color"], ["look", "Frame"], ["draft", "Draft"], ["final", "Final"]];
  }
  _has(id) {
    const r = { look: 2, draft: 3, final: 4 }[id];
    return r == null ? true : this.available(r);
  }
  /** B defaults to the best render that exists. */
  _bestB() { return ["final", "draft", "look", "color"].find((id) => this._has(id)) || "color"; }

  _drawBar() {
    if (!this.bar) return;
    const b = this.b && this._has(this.b) ? this.b : this._bestB();
    const mk = (side) => {
      const g = document.createElement("span");
      g.className = "grp";
      g.append(Object.assign(document.createElement("span"), { className: "lab", textContent: side === "a" ? "A" : "vs B" }));
      for (const [id, label] of this._stages()) {
        const btn = Object.assign(document.createElement("button"), { type: "button", textContent: label,
          title: this._has(id) ? `Compare ${label}` : `${label} not rendered yet` });
        btn.disabled = !this._has(id);
        if ((side === "a" ? this.a : b) === id) {
          btn.className = side;   // inline too: the App theme styles every button
          btn.style.cssText = side === "a" ? "background:#f2ff59 !important;color:#111 !important;border-color:#f2ff59 !important;font-weight:650"
            : "background:#fff !important;color:#111 !important;border-color:#fff !important;font-weight:650";
        }
        btn.addEventListener("click", () => { if (side === "a") this.a = id; else this.b = id; this._drawBar(); this.draw(); });
        g.append(btn);
      }
      return g;
    };
    const modes = document.createElement("span");
    modes.className = "grp mode";
    for (const [m, label] of [["wipe", "Wipe"], ["side", "Side by side"], ["fade", "Fade"]]) {
      const btn = Object.assign(document.createElement("button"), { type: "button", textContent: label });
      btn.setAttribute("aria-pressed", String(this.mode === m));
      if (this.mode === m) btn.style.cssText = "border-color:#f2ff59 !important;color:#f2ff59 !important";
      btn.addEventListener("click", () => { this.mode = m; this._drawBar(); this.draw(); });
      modes.append(btn);
    }
    this.bar.replaceChildren(mk("a"), mk("b"), modes);
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
    this.draw();
  }

  available(rung) {
    if (rung <= 1) return true;
    const s = this.sources[rung];
    if (!s) return false;
    return s.kind === "image" ? s.el.complete && s.el.naturalWidth > 0 : s.el.readyState >= 2;
  }

  setFidelity(f) {
    // The old single slider: the two neighbouring rungs, split by the fraction.
    this.fidelity = Math.min(RUNG_NAMES.length - 1, Math.max(0, f));
    const ids = ["wire", "clay", "look", "draft", "final"];
    const lo = Math.floor(this.fidelity), hi = Math.min(4, lo + 1);
    this.a = ids[lo]; this.b = ids[hi]; this.split = 1 - (this.fidelity - lo || 0.5);
    this._drawBar();
    this.draw();
  }

  setFrame(frame) {
    this.frame = Math.max(0, Math.round(frame));
    this.seek();
    this.draw();
  }

  seek() {
    const fps = this.stage.toJSON().shot?.fps || 24;
    for (const r of [3, 4]) {
      const s = this.sources[r];
      if (s?.kind === "video" && s.el.readyState >= 1) {
        const t = Math.min(this.frame / fps, Math.max(0, s.el.duration - 1 / fps));
        if (Math.abs(s.el.currentTime - t) > 0.5 / fps) s.el.currentTime = t;
      }
    }
  }

  /** Draw a stage (wire / clay / color / look / draft / final) into ctx's rect. Returns false if not ready. */
  _drawStage(id, ctx, x = 0, y = 0, w = this.canvas.width, h = this.canvas.height) {
    if (id === "wire" || id === "clay" || id === "color") {
      ctx.drawImage(this.stage.renderFrameTo(id, this.frame), x, y, w, h);
      return true;
    }
    const rung = { look: 2, draft: 3, final: 4 }[id];
    if (!this.available(rung)) {
      ctx.fillStyle = "#11151b"; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#7d8694"; ctx.font = "20px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${this._stages().find((s) => s[0] === id)?.[1]} not rendered yet`, x + w / 2, y + h / 2);
      ctx.textAlign = "start";
      return false;
    }
    ctx.drawImage(this.sources[rung].el, x, y, w, h);
    return true;
  }

  draw() {
    if (this.canvas.width !== this.stage.fw || this.canvas.height !== this.stage.fh) {
      this.canvas.width = this.stage.fw;
      this.canvas.height = this.stage.fh;
    }
    const { width: W, height: H } = this.canvas;
    const ctx = this.ctx;
    const A = this.a, B = this.b && this._has(this.b) ? this.b : this._bestB();
    const name = (id) => this._stages().find((s) => s[0] === id)?.[1] || id;
    const label = (txt, x, align, hot) => {
      ctx.font = "600 20px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = align;
      const w = ctx.measureText(txt).width + 20;
      ctx.fillStyle = hot ? "#f2ff59" : "rgba(0,0,0,0.6)";
      ctx.beginPath(); (ctx.roundRect ? ctx.roundRect(align === "left" ? x : x - w, 12, w, 32, 16) : ctx.rect(align === "left" ? x : x - w, 12, w, 32)); ctx.fill();
      ctx.fillStyle = hot ? "#111" : "#fff";
      ctx.fillText(txt, align === "left" ? x + 10 : x - 10, 35);
      ctx.textAlign = "start";
    };
    ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, W, H);
    if (this.mode === "side") {
      const w = W / 2, h = H / 2, y = H / 4;
      this._drawStage(A, ctx, 0, y, w, h);
      this._drawStage(B, ctx, w, y, w, h);
      label(name(A), 10, "left", true); label(name(B), W - 10, "right");
      return;
    }
    if (this.mode === "fade") {
      this._drawStage(A, ctx);
      ctx.save(); ctx.globalAlpha = this.split; this._drawStage(B, ctx); ctx.restore();
      label(`${name(A)} → ${name(B)} · ${Math.round(this.split * 100)}%`, 10, "left", true);
      return;
    }
    // Wipe: A on the left of the handle, B on the right.
    const sx = Math.round(W * this.split);
    this._drawStage(A, ctx);
    ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); this._drawStage(B, ctx); ctx.restore();
    ctx.fillStyle = "#f2ff59"; ctx.fillRect(sx - 1.5, 0, 3, H);
    ctx.beginPath(); ctx.arc(sx, H / 2, 22, 0, Math.PI * 2); ctx.fillStyle = "#f2ff59"; ctx.fill();
    ctx.fillStyle = "#111"; ctx.beginPath();
    ctx.moveTo(sx - 6, H / 2 - 8); ctx.lineTo(sx - 14, H / 2); ctx.lineTo(sx - 6, H / 2 + 8);
    ctx.moveTo(sx + 6, H / 2 - 8); ctx.lineTo(sx + 14, H / 2); ctx.lineTo(sx + 6, H / 2 + 8); ctx.fill();
    label(name(A), 10, "left", true); label(name(B), W - 10, "right");
  }
}
