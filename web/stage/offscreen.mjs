// Offscreen captures (Jon's canvas-speed report, 2026-11-08). Thumbnails (renderFrameTo) and captures (capture,
// captureSequence) used to resize the VISIBLE canvas to the delivery size, render, copy and resize it back: two
// drawing-buffer reallocations plus a viewport re-render per thumbnail, 1.5-2 s of long tasks in a session, and a
// blank frame on screen meanwhile. They now render into ONE reused WebGLRenderTarget at the delivery size and read it
// back, so the visible canvas is never resized and never redrawn for a thumbnail.
//
// Pixel parity with the canvas path (the Stage node's passes must not change; tests/browser checks it in real WebGL):
//   - colour: three renders a render target in linear and skips tone mapping, unlike the canvas. isXRRenderTarget makes
//     three treat this target like the screen (its outputColorSpace and toneMapping, the sRGB clear colour), and an
//     explicit RGBA8 internal format stops a second, hardware sRGB encode. Raw ShaderMaterials (Depth, water, fire)
//     write gl_FragColor as they did into the canvas.
//   - antialiasing: the canvas's own MSAA sample count (gl.SAMPLES of the default framebuffer).
//   - alpha: the canvas is opaque (the renderer has alpha: false), so the read-back is made opaque the same way.
//   - point sizes: three sizes attenuated points by the CANVAS height (renderer _height), not the target's, so their
//     size is scaled by targetH / canvasH for the render. Shaders that read the canvas height (underwater bubbles) ask
//     stage.drawSize() instead.
// Rows come back bottom-up from readPixels; flipRows() puts them top-down.

/** Copy RGBA rows bottom-up -> top-down from src into dst (both w*h*4), alpha forced to 255 (an opaque canvas). */
export function flipOpaque(src, dst, w, h) {
  const row = w * 4;
  for (let y = 0; y < h; y++) dst.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
  return dst;
}

/**
 * Scale every size-attenuated PointsMaterial in `root` by k for one render; returns the function that puts them back.
 * Each material is scaled once, however many Points share it.
 */
export function scalePointSizes(root, k) {
  if (!root || !(k > 0) || Math.abs(k - 1) < 1e-9) return () => {};
  const done = new Map();
  root.traverse?.((o) => {
    if (!o.isPoints) return;
    for (const m of [].concat(o.material || [])) {
      if (!m?.isPointsMaterial || m.sizeAttenuation === false || done.has(m)) continue;
      done.set(m, m.size);
      m.size *= k;
    }
  });
  return () => { for (const [m, s] of done) m.size = s; };
}

/** The canvas's MSAA sample count (0 without antialiasing), read once from the default framebuffer. */
function canvasSamples(renderer) {
  try {
    const gl = renderer.getContext?.();
    if (!gl) return 0;
    if (!gl.getContextAttributes?.()?.antialias) return 0;
    const n = gl.getParameter(gl.SAMPLES);
    const max = gl.getParameter(gl.MAX_SAMPLES) || 4;
    return Math.max(0, Math.min(Number.isFinite(n) ? n : 4, max));
  } catch { return 4; }
}

/** Install the offscreen capture methods on the Stage class (THREE passed in, so this file has no import). */
export function installOffscreen(Stage, THREE) {
  const P = Stage.prototype;

  /** The reused capture target, (re)sized to w x h. */
  P._captureTarget = function (w, h) {
    let rt = this._capRT;
    if (!rt) {
      if (this._capSamples == null) this._capSamples = canvasSamples(this.renderer);
      rt = new THREE.WebGLRenderTarget(w, h, { samples: this._capSamples, depthBuffer: true, stencilBuffer: true });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      rt.texture.internalFormat = "RGBA8";   // storage stays linear bytes, like the canvas: no hardware sRGB encode on top
      rt.isXRRenderTarget = true;            // three renders it like the screen: output colour space, tone mapping, clear colour
      this._capRT = rt;
      this.stats ||= {};
      this.stats.captureTargets = (this.stats.captureTargets || 0) + 1;
    } else if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    return rt;
  };

  /** The size the current render draws at: the capture target while one is bound, else the canvas. */
  P.drawSize = function () {
    if (this._drawTo) return [this._drawTo.width, this._drawTo.height];
    const c = this.renderer?.domElement || this.canvas;
    return [c?.width || this.fw, c?.height || this.fh];
  };

  /** Run fn (which renders) into the capture target at w x h; the visible canvas is untouched. */
  P._withOffscreen = function (w, h, fn) {
    const r = this.renderer;
    const rt = this._captureTarget(w, h);
    const prevRT = r.getRenderTarget(), prevDraw = this._drawTo;
    const v = new THREE.Vector2();
    r.getSize(v);
    const putBack = scalePointSizes(this.scene, v.y > 0 ? h / v.y : 1);
    this._drawTo = rt;
    r.setRenderTarget(rt);
    try { return fn(rt); } finally {
      r.setRenderTarget(prevRT);
      this._drawTo = prevDraw;
      putBack();
    }
  };

  /** Render one pass offscreen at w x h and read it back as an (opaque, top-down) ImageData, reused per size. */
  P._renderOffscreen = function (mode, w = this.fw, h = this.fh) {
    return this._withOffscreen(w, h, (rt) => {
      this._renderMode(mode, true);
      const n = w * h * 4;
      if (!this._capPx || this._capPx.length !== n) this._capPx = new Uint8Array(n);
      if (!this._capImg || this._capImg.width !== w || this._capImg.height !== h) this._capImg = new ImageData(w, h);
      this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, this._capPx);
      flipOpaque(this._capPx, this._capImg.data, w, h);
      return this._capImg;
    });
  };

  const dispose0 = P.dispose;
  P.dispose = function () {
    try { this._capRT?.dispose?.(); } catch { /* */ }
    this._capRT = null;
    return dispose0.call(this);
  };
}
