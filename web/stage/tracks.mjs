// Per-object timeline ("dope sheet"): a Camera row plus one row per object, each with its keys as diamonds,
// the way Magnific 3D Scenes lays out its timeline. Click a name to select it, click/drag the ruler or an empty
// spot to scrub, drag a diamond to retime that key (it stays between its neighbours), double-click a row to add
// a key there, right-click a diamond to delete it (the last key of a track always stays). A rider's hop-on
// frame shows as a small arc marker. One undo step per gesture.
import { TOKENS } from "../ui/theme.mjs";

const ROW = 22, HEAD = 16, NAME_W = 118, PAD = 10;

export class TrackSheet {
  constructor(host, stage, { onFrame, onKeysChanged } = {}) {
    this.stage = stage;
    this.onFrame = onFrame || (() => {});
    this.onKeysChanged = onKeysChanged || (() => {});
    this.el = document.createElement("div");
    this.el.className = "ss-tracks";
    this.el.style.cssText = "position:relative;max-height:176px;overflow-y:auto;border-radius:10px;" +
      "background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);margin-top:6px";
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "display:block;width:100%;touch-action:none;cursor:default";
    this.el.append(this.canvas);
    host.append(this.el);
    this.drag = null;
    this.hover = null;
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointercancel", (e) => this._up(e));
    c.addEventListener("dblclick", (e) => this._dbl(e));
    c.addEventListener("contextmenu", (e) => this._ctx(e));
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(this.el);
  }

  set hidden(v) { this.el.hidden = v; if (!v) this.draw(); }
  get hidden() { return this.el.hidden; }

  dispose() { this._ro.disconnect(); this.el.remove(); }

  /** Rows: camera first, then every object in scene order. */
  _rows() {
    const st = this.stage;
    const rows = [{ kind: "camera", id: "__camera__", name: "Camera", keys: st._camKeys(), color: "#e39a40" }];
    for (const a of st.state.actors || []) {
      rows.push({ kind: "actor", id: a.id, a, name: a.name || a.kind || a.id, keys: st._actorKeys(a),
        color: a.mount_id ? "#b9a7ff" : "#539bf5" });
      if (a.id === st.selected) rows.push(...(st.partRows?.(a.id) || []));   // its animated Parts channels (objparts.mjs)
    }
    if (st.selectedLight) rows.push(...(st.partRows?.(`light:${st.selectedLight}`) || []));
    return rows;
  }

  _last() { return Math.max(1, this.stage._lastFrame()); }

  _x(f) { const w = this.canvas.clientWidth; return NAME_W + PAD + (f / this._last()) * (w - NAME_W - 2 * PAD); }

  _frameAt(px) {
    const w = this.canvas.clientWidth;
    const f = Math.round(((px - NAME_W - PAD) / Math.max(1, w - NAME_W - 2 * PAD)) * this._last());
    return Math.min(this._last(), Math.max(0, f));
  }

  /** Pointer → canvas CSS pixels; the graph canvas can scale the widget, so undo that zoom. */
  _pt(e) {
    const r = this.canvas.getBoundingClientRect(), c = this.canvas;
    return [(e.clientX - r.left) * (c.clientWidth / Math.max(1, r.width)), (e.clientY - r.top) * (c.clientHeight / Math.max(1, r.height))];
  }

  _hit(x, y) {
    const rows = this._rows();
    if (y < HEAD) return { zone: "ruler", rows };
    const i = Math.floor((y - HEAD) / ROW);
    const row = rows[i];
    if (!row) return { zone: "none", rows };
    if (x < NAME_W) return { zone: "name", row, rows };
    const cy = HEAD + i * ROW + ROW / 2;
    const k = row.keys.findIndex((q) => Math.abs(this._x(q.frame) - x) <= 7 && Math.abs(cy - y) <= 9);
    return k >= 0 ? { zone: "key", row, k, rows } : { zone: "row", row, rows };
  }

  _scrub(f) { this.stage.setFrame(f); this.onFrame(f); this.draw(); }

  _down(e) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const [x, y] = this._pt(e);
    const h = this._hit(x, y);
    this.canvas.setPointerCapture(e.pointerId);
    if (h.zone === "name") {
      if (h.row.kind === "part") { if (!String(h.row.ownerId).startsWith("light:")) this.stage.select(h.row.ownerId); }
      else this.stage.select(h.row.kind === "actor" ? h.row.id : null);
      this.draw();
      return;
    }
    if (h.zone === "key") {
      const key = h.row.keys[h.k];
      if (h.row.kind === "actor") this.stage.select(h.row.id);
      this.drag = { kind: "key", row: h.row, key, from: key.frame, moved: false };
      this._scrub(key.frame);
      return;
    }
    if (h.zone === "ruler" || h.zone === "row") { this.drag = { kind: "scrub" }; this._scrub(this._frameAt(x)); }
  }

  _move(e) {
    const [x, y] = this._pt(e);
    if (!this.drag) {
      const h = this._hit(x, y);
      const hov = h.zone === "key" ? `${h.row.id}:${h.k}` : null;
      this.canvas.style.cursor = h.zone === "key" ? "ew-resize" : h.zone === "name" ? "pointer" : "default";
      if (hov !== this.hover) { this.hover = hov; this.draw(); }
      return;
    }
    if (this.drag.kind === "scrub") { this._scrub(this._frameAt(x)); return; }
    const { row, key } = this.drag;
    const keys = row.keys, i = keys.indexOf(key);
    const lo = i > 0 ? keys[i - 1].frame + 1 : 0;
    const hi = i < keys.length - 1 ? keys[i + 1].frame - 1 : this._last();
    const f = Math.min(hi, Math.max(lo, this._frameAt(x)));
    if (f !== key.frame) { key.frame = f; this.drag.moved = true; this._scrub(f); this.onKeysChanged(); }
  }

  _up(e) {
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    if (d?.kind === "key" && d.moved) this._commit();
  }

  _dbl(e) {
    e.stopPropagation();
    const [x, y] = this._pt(e);
    const h = this._hit(x, y);
    if (h.zone !== "row") return;
    const f = this._frameAt(x);
    this.stage.setFrame(f);
    if (h.row.kind === "camera") this.stage._editCamera();
    else if (h.row.kind === "part") h.row.addKey(f);
    else { this.stage.select(h.row.id); this.stage._editActorKey(h.row.a); }
    this.onFrame(f);
    this._commit();
  }

  _ctx(e) {
    const [x, y] = this._pt(e);
    const h = this._hit(x, y);
    if (h.zone !== "key") return;
    e.preventDefault();
    const drop = h.row.keys[h.k];
    if (h.row.kind === "part") { h.row.drop(drop); this._commit(); return; }   // a channel's last key may go: back to its default
    if (h.row.keys.length < 2) return;
    if (h.row.kind === "camera") this.stage.activeShot().camera_keys = h.row.keys.filter((k) => k !== drop);
    else h.row.a.keys = h.row.keys.filter((k) => k !== drop);
    this._commit();
  }

  _commit() {
    const st = this.stage;
    st.setFrame(st.frame);
    st.onChange(st.toJSON());
    this.onKeysChanged();
    this.draw();
  }

  draw() {
    if (this.el.hidden || !this.canvas.isConnected) return;
    const st = this.stage, rows = this._rows();
    const dpr = window.devicePixelRatio || 1, w = this.canvas.clientWidth || 600, h = HEAD + rows.length * ROW + 4;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    const g = this.canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const last = this._last(), fps = st.state.shot?.fps || 24;
    // Ruler: a tick per second.
    g.font = "500 9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; g.textBaseline = "middle"; g.textAlign = "center";
    for (let s = 0; s * fps <= last; s++) {
      const x = this._x(s * fps);
      g.fillStyle = "rgba(240,239,237,.35)"; g.fillRect(x, HEAD - 5, 1, 5);
      g.fillStyle = TOKENS.muted; g.fillText(`${s}s`, x, 6);
    }
    rows.forEach((r, i) => {
      const y = HEAD + i * ROW, cy = y + ROW / 2;
      const sel = (r.kind === "actor" && r.id === st.selected) || (r.kind === "camera" && !st.selected) || r.kind === "part";
      if (sel) { g.fillStyle = "rgba(242,255,89,.06)"; g.fillRect(0, y, w, ROW); }
      g.fillStyle = "rgba(255,255,255,.05)"; g.fillRect(0, y + ROW - 1, w, 1);
      g.fillStyle = r.color; g.beginPath(); g.arc(10, cy, 3.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = sel ? TOKENS.text : TOKENS.muted; g.textAlign = "left";
      g.font = `${sel ? 600 : 500} 11px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif`;
      let name = r.name;
      while (name.length > 3 && g.measureText(name).width > NAME_W - 26) name = name.slice(0, -2);
      g.fillText(name === r.name ? name : `${name}…`, 20, cy);
      // Span between first and last key, so a track's active range reads at a glance.
      if (r.keys.length > 1) {
        g.fillStyle = `${r.color}33`;
        g.fillRect(this._x(r.keys[0].frame), cy - 1.5, this._x(r.keys[r.keys.length - 1].frame) - this._x(r.keys[0].frame), 3);
      }
      if (r.kind === "actor" && r.a.mount_at > 0) { // hop-on marker
        const mx = this._x(r.a.mount_at);
        g.strokeStyle = "#b9a7ff"; g.lineWidth = 1.5; g.beginPath(); g.arc(mx, cy + 4, 6, Math.PI, 0); g.stroke();
      }
      r.keys.forEach((k, j) => {
        const x = this._x(k.frame), hot = this.hover === `${r.id}:${j}` || this.drag?.key === k, s = hot ? 7 : 5.5;
        g.beginPath(); g.moveTo(x, cy - s); g.lineTo(x + s, cy); g.lineTo(x, cy + s); g.lineTo(x - s, cy); g.closePath();
        g.fillStyle = hot ? TOKENS.accent : r.color; g.fill();
        g.strokeStyle = TOKENS.bg; g.lineWidth = 1; g.stroke();
      });
    });
    const px = this._x(st.frame || 0);
    g.fillStyle = TOKENS.accent; g.fillRect(px - 0.75, 0, 1.5, h);
    if (this.drag?.kind === "key") {
      g.fillStyle = TOKENS.accent; g.textAlign = "center"; g.font = "600 10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      g.fillText(`f${this.drag.key.frame}`, Math.min(w - 16, px + 16), 6);
    }
  }
}
