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
    this.fidelity = 1; // 0..4, fractional = blend between neighbours
    this.frame = 0;
    this.mode = "wipe";
    this.sources = { 2: null, 3: null, 4: null }; // Look image, Draft video, Final video

    this.canvas = document.createElement("canvas");
    this.canvas.width = 960;
    this.canvas.height = 512;
    this.canvas.style.cssText = "display:block;width:100%;height:auto;border-radius:4px;background:#0d1117;cursor:ew-resize";
    this.ctx = this.canvas.getContext("2d");
    container.appendChild(this.canvas);

    // Drag on the picture to wipe between rungs, like a before/after slider.
    let dragging = false;
    const fromPointer = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.setFidelity(x * (RUNG_NAMES.length - 1));
      this.onFidelity?.(this.fidelity);
    };
    this.canvas.addEventListener("pointerdown", (e) => { e.stopPropagation(); dragging = true; this.canvas.setPointerCapture(e.pointerId); fromPointer(e); });
    this.canvas.addEventListener("pointermove", (e) => { if (dragging) { e.stopPropagation(); fromPointer(e); } });
    this.canvas.addEventListener("pointerup", () => (dragging = false));
  }

  /** Register a finished rung result. kind: "image" or "video"; url: a /view URL. */
  setSource(rung, kind, url) {
    if (kind === "image") {
      const img = new Image();
      img.onload = () => this.draw();
      img.src = url;
      this.sources[rung] = { kind, el: img, url };
    } else {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.playsInline = true;
      v.crossOrigin = "anonymous";
      v.addEventListener("seeked", () => this.draw());
      v.addEventListener("loadeddata", () => { this.seek(); this.draw(); }); // at frame 0 there is no seek, so draw now
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
    this.fidelity = Math.min(RUNG_NAMES.length - 1, Math.max(0, f));
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

  /** Draw one rung into the canvas at the current frame. Returns false if it isn't ready. */
  _drawRung(rung, ctx) {
    const { width: W, height: H } = this.canvas;
    if (rung <= 1) {
      const img = this.stage.renderFrameTo(rung === 0 ? "wire" : "clay", this.frame);
      ctx.drawImage(img, 0, 0, W, H);
      return true;
    }
    if (!this.available(rung)) {
      ctx.fillStyle = "#11151b";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#7d8694";
      ctx.font = "22px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${RUNG_NAMES[rung]} not rendered yet — press Run to climb the ladder`, W / 2, H / 2);
      ctx.textAlign = "start";
      return false;
    }
    ctx.drawImage(this.sources[rung].el, 0, 0, W, H);
    return true;
  }

  draw() {
    if (this.canvas.width !== this.stage.fw || this.canvas.height !== this.stage.fh) {
      this.canvas.width = this.stage.fw;
      this.canvas.height = this.stage.fh;
    }
    const { width: W, height: H } = this.canvas;
    const ctx = this.ctx;
    const lo = Math.floor(this.fidelity);
    const hi = Math.min(RUNG_NAMES.length - 1, lo + 1);
    const t = this.fidelity - lo;
    this._drawRung(lo, ctx);
    if (t > 0.001 && hi !== lo) {
      if (this.mode === "fade") {
        ctx.save();
        ctx.globalAlpha = t;
        this._drawRung(hi, ctx);
        ctx.restore();
      } else {
        // Wipe: the higher rung is revealed from the left up to the split line.
        const split = Math.round(W * t);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, split, H);
        ctx.clip();
        this._drawRung(hi, ctx);
        ctx.restore();
        ctx.fillStyle = "#e39a40";
        ctx.fillRect(split - 1, 0, 3, H);
      }
    }
    // Rung labels
    ctx.font = "600 18px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    const label = (txt, x, align) => {
      ctx.textAlign = align;
      const w = ctx.measureText(txt).width + 16;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(align === "left" ? x : x - w, 10, w, 28);
      ctx.fillStyle = "#fff";
      ctx.fillText(txt, align === "left" ? x + 8 : x - 8, 30);
    };
    if (t > 0.001 && hi !== lo && this.mode === "wipe") {
      label(RUNG_NAMES[hi], 10, "left");
      label(RUNG_NAMES[lo], W - 10, "right");
    } else {
      label(RUNG_NAMES[t > 0.5 ? hi : lo], 10, "left");
    }
    ctx.textAlign = "start";
  }
}
