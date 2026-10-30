// Pose Studio for the selected person: a pose gallery, Mirror / Clear, and a slider for every joint axis, grouped like
// Pose Studio (head & spine, each arm, each hand finger by finger, each leg). Values are keyed at the playhead, so a pose
// can change during the shot; LTX copies the clay pose, so this is how a head turn or a gesture gets directed.
import { jointGroups, JOINT_AXES, jointKind, jointRange, POSE_PRESETS } from "./humans.mjs";
import { captureTake, recordTake } from "./mocapcapture.mjs";

const ICON = {
  film: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  person: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2"/><path d="M12 7v6M12 9l-4 3M12 9l4-2.5M12 13l-3 7M12 13l3.5 6.5"/></svg>',
  record: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.5" fill="#ff453a"/></svg>',
};

const CSS = `
.ss-pose { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,.035);
  border:1px solid rgba(255,255,255,.08); font-size:12px; }
.ss-pose .row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.ss-pose .chip { border-radius:999px; padding:3px 10px; font:inherit; cursor:pointer; background:rgba(255,255,255,.06);
  color:inherit; border:1px solid rgba(255,255,255,.12); }
.ss-pose .chip:hover { border-color:#f2ff59; }
.ss-pose details { border-top:1px solid rgba(255,255,255,.06); padding-top:6px; }
.ss-pose summary { cursor:pointer; font-weight:600; }
.ss-pose .joints { display:grid; grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); gap:6px 14px; margin-top:6px; }
.ss-pose .joint { display:flex; flex-direction:column; gap:2px; min-width:0; }
.ss-pose .joint b { font-weight:600; font-size:11px; opacity:.9; }
.ss-pose .ax { display:grid; grid-template-columns:78px 1fr 38px; gap:6px; align-items:center; }
.ss-pose .ax span { opacity:.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-pose .ax output { text-align:right; font-variant-numeric:tabular-nums; opacity:.85; }
.ss-pose input[type=range] { width:100%; accent-color:#f2ff59; }
.ss-pose .note { opacity:.7; }
.ss-pose .mocap { display:flex; flex-direction:column; gap:8px; padding:10px; border-radius:10px; background:rgba(242,255,89,.05);
  border:1px solid rgba(242,255,89,.18); }
.ss-pose .mocap .title { display:flex; align-items:center; gap:6px; font-weight:650; font-size:13px; }
.ss-pose .big { display:inline-flex; align-items:center; gap:8px; border-radius:10px; padding:8px 14px; font:inherit; font-weight:600;
  cursor:pointer; background:rgba(255,255,255,.07); color:inherit; border:1px solid rgba(255,255,255,.16); }
.ss-pose .big:hover:not(:disabled) { border-color:#f2ff59; }
.ss-pose .big:disabled { opacity:.45; cursor:default; }
.ss-pose .take { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.ss-pose .take b { font-weight:600; }`;

export class PosePanel {
  constructor(container, { stage, api = null, onStatus = () => {} } = {}) {
    this.stage = stage; this.api = api; this.onStatus = onStatus; this.id = null; this.inputs = new Map();
    if (!document.getElementById("ss-pose-css")) {
      const st = Object.assign(document.createElement("style"), { id: "ss-pose-css", textContent: CSS });
      document.head.append(st);
    }
    this.el = Object.assign(document.createElement("div"), { className: "ss-pose", hidden: true });
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    container.append(this.el);
    this._build();
    this._lastFrame = -1;
    // Refresh when the playhead moves or the pose changes from elsewhere (undo, a gallery pick, the gizmo).
    this._poll = setInterval(() => {
      if (this.el.hidden || !this.id) return;
      const sig = this._sig();
      if (this.stage.frame !== this._lastFrame || sig !== this._lastSig) this.refresh();
    }, 250);
  }

  _btn(label, title, fn) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: label, title });
    b.addEventListener("click", fn);
    return b;
  }

  // Motion capture: a performance from a clip (phone video, an existing scene) or acted out on the webcam drives this
  // person's whole body, hands and path. Runs SAM 3D Body in ComfyUI.
  _buildMocap() {
    const box = Object.assign(document.createElement("div"), { className: "mocap" });
    const title = Object.assign(document.createElement("div"), { className: "title" });
    title.innerHTML = `${ICON.person}<span>Motion capture</span>`;
    const note = Object.assign(document.createElement("div"), { className: "note",
      textContent: "Copy a real performance onto this person: a clip from your phone or an existing video, or act it out on the webcam. Body, hands, fingers and the path all come across." });
    const file = Object.assign(document.createElement("input"), { type: "file", accept: "video/*,.mp4,.mov,.webm,.mkv", hidden: true });
    const big = (icon, label, title) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "big", title });
      b.innerHTML = `${icon}<span>${label}</span>`;
      return b;
    };
    this.mcFile = big(ICON.film, "Capture from video…", "Pick a video of one person performing the action (a few seconds is best)");
    this.mcAct = big(ICON.record, "Act it out", "Record yourself on the webcam with a 3-2-1 countdown");
    this.mcFile.addEventListener("click", () => file.click());
    file.addEventListener("change", () => { const f = file.files?.[0]; file.value = ""; if (f) this._capture(f, 0); });
    this.mcAct.addEventListener("click", async () => {
      const r = await recordTake({ seconds: 6 });
      if (r?.blob) this._capture(r.blob, r.duration);
    });
    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.append(this.mcFile, this.mcAct, file);
    this.mcTake = Object.assign(document.createElement("div"), { className: "take" });
    box.append(title, note, row, this.mcTake);
    return box;
  }

  async _capture(blob, duration) {
    const id = this.id;
    if (!id) return;
    if (!this.api) { this.onStatus("Motion capture needs the ComfyUI server (it runs SAM 3D Body on the GPU)."); return; }
    this.mcFile.disabled = this.mcAct.disabled = true;
    const say = (m) => { this.mcTake.textContent = m; this.onStatus(m); };
    try {
      const take = await captureTake(this.api, blob, { name: blob.name, duration, onStatus: say });
      const msg = this.stage.setMocap(id, take, { start: this.stage.frame });
      say(`${msg} Captured in ${Math.round(take.seconds)} s.`);
    } catch (e) {
      say(`Motion capture failed: ${e.message}`);
    } finally {
      this.mcFile.disabled = this.mcAct.disabled = false;
      this._drawTake();
    }
  }

  _drawTake() {
    const info = this.id && this.stage.mocapInfo?.(this.id);
    if (!info) { if (!this.mcFile?.disabled) this.mcTake.replaceChildren(); return; }
    const label = Object.assign(document.createElement("span"), {
      innerHTML: `<b>${info.name.replace(/[<&]/g, "")}</b> · ${info.loaded ? `${info.seconds.toFixed(1)} s · frames ${info.start}–${info.end}` : "loading…"}` });
    const travel = Object.assign(document.createElement("label"), { className: "chip", title: "Move through the set as the performer did (off: perform on the spot)" });
    const tc = Object.assign(document.createElement("input"), { type: "checkbox", checked: info.travel });
    tc.addEventListener("change", () => { this.stage.setMocapOption(this.id, "travel", tc.checked); this._drawTake(); });
    travel.append(tc, document.createTextNode(" Travel"));
    this.mcTake.replaceChildren(label,
      this._btn("Start at playhead", "The take begins at the current frame", () => { this.stage.setMocapOption(this.id, "start", this.stage.frame); this._drawTake(); this.onStatus(`Take starts at frame ${this.stage.frame}.`); }),
      travel,
      this._btn("Remove take", "Back to the walk / pose keys", () => { this.stage.clearMocap(this.id); this._drawTake(); this.onStatus("Motion take removed."); }));
  }

  _build() {
    this.el.append(this._buildMocap());
    const head = document.createElement("div");
    head.className = "row";
    this.title = Object.assign(document.createElement("strong"), { textContent: "Pose" });
    this.keyInfo = Object.assign(document.createElement("span"), { className: "note" });
    head.append(this.title, this.keyInfo,
      this._btn("Mirror L↔R", "Swap the left and right side of the pose at the playhead", () => this._do(() => this.stage.mirrorPoseAt(this.id), "Mirrored.")),
      this._btn("Clear key here", "Remove the pose key at the playhead", () => this._do(() => this.stage.clearPose(this.id), "Key removed.")),
      this._btn("Reset pose", "Remove every pose key: back to the plain walk / seat pose", () => this._do(() => this.stage.clearPose(this.id, true), "Pose reset.")));
    const gallery = document.createElement("div");
    gallery.className = "row";
    gallery.append(Object.assign(document.createElement("span"), { className: "note", textContent: "Gallery:" }),
      ...Object.keys(POSE_PRESETS).map((n) => this._btn(n, `Apply “${n}” at the playhead`, () => this._do(() => this.stage.applyPosePreset(this.id, n), `${n} at frame ${this.stage.frame}.`))));
    // Interact: look at / talk / shake hands / hug / hold hands / point / pet / lead.
    const inter = document.createElement("div");
    inter.className = "row";
    this.target = document.createElement("select");
    this.action = document.createElement("select");
    for (const [v, l] of [["look_at", "Look at"], ["talk", "Talk to (face each other)"], ["handshake", "Shake hands"], ["hug", "Hug"],
      ["hold_hands", "Hold hands"], ["point_at", "Point at"], ["pet", "Pet (dog, cat, horse)"], ["lead", "Lead by the reins (horse)"], ["stop_look", "Stop looking"]])
      this.action.append(new Option(l, v));
    for (const el of [this.target, this.action]) el.addEventListener("pointerdown", (e) => e.stopPropagation());
    inter.append(Object.assign(document.createElement("span"), { className: "note", textContent: "Interact:" }), this.action,
      Object.assign(document.createElement("span"), { className: "note", textContent: "with" }), this.target,
      this._btn("Do it at the playhead", "Positions, faces and poses them for the interaction at the playhead",
        () => { const m = this.stage.interact(this.id, this.target.value, this.action.value); this.refresh(); this.onStatus(m || "Pick someone or something to interact with."); }));
    this.el.append(inter);
    const hint = Object.assign(document.createElement("div"), { className: "note",
      textContent: "Every slider keys the pose at the playhead. One key holds for the whole shot; add more at other frames and the pose eases between them (a head turn at 2 s). The video follows the clay pose." });
    this.el.prepend(head);
    this.el.append(gallery, hint);
    for (const grp of jointGroups()) {
      const d = document.createElement("details");
      d.append(Object.assign(document.createElement("summary"), { textContent: grp.label }));
      const box = Object.assign(document.createElement("div"), { className: "joints" });
      for (const [id, label] of grp.joints) {
        const j = Object.assign(document.createElement("div"), { className: "joint" });
        j.append(Object.assign(document.createElement("b"), { textContent: label }));
        const axes = JOINT_AXES[jointKind(id)] || [];
        const ins = [];
        axes.forEach((name, n) => {
          if (!name) return;
          const [lo, hi] = jointRange(id, n);
          const row = Object.assign(document.createElement("label"), { className: "ax" });
          const inp = Object.assign(document.createElement("input"), { type: "range", min: String(lo), max: String(hi), step: "1", value: "0" });
          const out = document.createElement("output");
          out.textContent = "0°";
          inp.addEventListener("input", () => {
            out.textContent = `${inp.value}°`;
            const cur = this.stage.poseInfo(this.id)?.pose?.[id] || [0, 0, 0];
            const v = [0, 1, 2].map((k) => (k === n ? +inp.value : cur[k] || 0));
            this.stage.setJoint(this.id, id, v);
            this._keys();
          });
          inp.addEventListener("dblclick", () => { inp.value = "0"; inp.dispatchEvent(new Event("input")); });
          row.append(Object.assign(document.createElement("span"), { textContent: name, title: name }), inp, out);
          j.append(row);
          ins.push([n, inp, out]);
        });
        this.inputs.set(id, ins);
        box.append(j);
      }
      d.append(box);
      this.el.append(d);
    }
  }

  _do(fn, msg) {
    if (!this.id) return;
    fn();
    this.refresh();
    this.onStatus(msg);
  }

  _keys() {
    const info = this.stage.poseInfo(this.id);
    const k = info?.keys || [];
    this.keyInfo.textContent = k.length ? `${info.here ? "Key here" : "Between keys"} · frame ${this.stage.frame} · ${k.length} key${k.length > 1 ? "s" : ""} (${k.join(", ")})`
      : `No pose yet · frame ${this.stage.frame}`;
  }

  /** Show for a person (null hides). */
  show(info) {
    const person = info && ["man", "woman", "child"].includes(info.kind);
    this.el.hidden = !person;
    this.id = person ? info.id : null;
    if (person) {
      this.title.textContent = `Pose · ${info.name}`;
      this._drawTake();
      const others = (this.stage.toJSON().actors || []).filter((a) => a.id !== info.id && !a.carry_id);
      const keep = this.target.value;
      this.target.replaceChildren(...others.map((a) => new Option(a.name || a.kind, a.id)));
      if (others.some((a) => a.id === keep)) this.target.value = keep;
      this.refresh();
    }
  }

  _sig() {
    const a = this.stage.toJSON?.().actors?.find((x) => x.id === this.id);
    return JSON.stringify(a?.pose_keys || null);
  }

  refresh() {
    if (!this.id) return;
    this._lastFrame = this.stage.frame;
    this._lastSig = this._sig();
    const pose = this.stage.poseInfo(this.id)?.pose || {};
    for (const [id, ins] of this.inputs) {
      const v = pose[id] || [0, 0, 0];
      for (const [n, inp, out] of ins) { inp.value = String(Math.round(v[n] || 0)); out.textContent = `${inp.value}°`; }
    }
    this._keys();
  }

  dispose() { clearInterval(this._poll); this.el.remove(); }
}
