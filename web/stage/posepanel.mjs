// Pose Studio for the selected person: a pose gallery, Mirror / Clear, and a slider for every joint axis, grouped like
// Pose Studio (head & spine, each arm, each hand finger by finger, each leg). Values are keyed at the playhead, so a pose
// can change during the shot; LTX copies the clay pose, so this is how a head turn or a gesture gets directed.
import { jointGroups, JOINT_AXES, jointKind, jointRange, POSE_PRESETS } from "./humans.mjs";
import { captureTake, recordTake } from "./mocapcapture.mjs";
import { clipSeconds, capturePlan } from "../ui/videoimport.mjs";
import { sourceLine } from "../ui/sourcespec.mjs";

import { icon } from "../ui/icons.mjs";
import { spotlight } from "../ui/theme.mjs";

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
.ss-pose .take b { font-weight:600; }
.ss-pose .lead { display:flex; flex-wrap:wrap; gap:4px; padding:4px; border-radius:12px; background:rgba(0,0,0,.18); }
.ss-pose .sect { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:2px 0; border-radius:10px; }
.ss-pose .sect > .lbl { display:inline-flex; align-items:center; gap:6px; min-width:84px; font-size:11px; font-weight:600;
  text-transform:uppercase; letter-spacing:.08em; opacity:.62; }
.ss-pose .head { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.ss-pose .head strong { font-size:15px; font-weight:600; margin-right:4px; }
.ss-pose .ss-tool[aria-pressed="true"] { border-color:#f2ff59; color:#f2ff59; background:rgba(242,255,89,.1); }`;

export class PosePanel {
  constructor(container, { stage, api = null, onStatus = () => {}, ...opts } = {}) {
    this.stage = stage; this.api = api; this.onStatus = onStatus; this.id = null; this.inputs = new Map();
    this.opts = opts;   // job: () => JobCard, actions: () => result buttons, onTake: (oldFrames) => {}
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

  /** A labelled tool button: icon on top, a short label under it (the App's tool style, ui/theme.mjs). */
  _tool(ic, label, title, fn) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "ss-tool", title });
    b.append(icon(ic, 20), Object.assign(document.createElement("span"), { textContent: label }));
    b.dataset.ssIcon = ic;
    b.setAttribute("aria-label", `${label}: ${title}`);
    if (fn) b.addEventListener("click", fn);
    return b;
  }

  /** Bring a section of the panel into view and light it up: "pose" | "interact" | "capture" | "joints". */
  focusSection(k) {
    if (this.el.hidden) return false;
    if (k === "capture") spotlight(this.mocapBox, this.mcFile);
    else if (k === "interact") spotlight(this.interRow, this.action);
    else if (k === "joints") { const d = this.el.querySelector("details"); if (d) { d.open = true; spotlight(d, d.querySelector("summary")); } }
    else spotlight(this.galleryRow, this.galleryRow.querySelector("button"));
    return true;
  }

  // Motion capture: a performance from a clip (phone video, an existing scene) or acted out on the webcam drives this
  // person's whole body, hands and path. Runs SAM 3D Body in ComfyUI.
  _buildMocap() {
    const box = Object.assign(document.createElement("div"), { className: "mocap" });
    const title = Object.assign(document.createElement("div"), { className: "title" });
    title.append(icon("webcam", 16), Object.assign(document.createElement("span"), { textContent: "Motion capture" }));
    const note = Object.assign(document.createElement("div"), { className: "note",
      textContent: "Copy a real performance onto this person: Capture from video (a clip from your phone or an existing scene) or Act it out on the webcam, above. Body, hands, fingers and the path all come across." });
    const file = Object.assign(document.createElement("input"), { type: "file", accept: "video/*,.mp4,.mov,.webm,.mkv", hidden: true });
    this.mcFile = this._tool("file-video-camera", "Capture from video", "Capture a performance from a video of one person (a few seconds is best)");
    this.mcAct = this._tool("circle-dot", "Act it out", "Record yourself on the webcam with a 3-2-1 countdown; your body, hands and path drive this person");
    this.mcAct.querySelector("svg").style.color = "#ff453a";
    this.mcFile.addEventListener("click", () => file.click());
    file.addEventListener("change", () => { const f = file.files?.[0]; file.value = ""; if (f) this._capture(f, 0); });
    this.mcAct.addEventListener("click", async () => {
      const r = await recordTake({ seconds: 6 });
      if (r?.blob) this._capture(r.blob, r.duration);
    });
    this.mcTake = Object.assign(document.createElement("div"), { className: "take" });
    box.append(title, note, file, this.mcTake);   // the two capture buttons sit in the lead row (see _build)
    this.mocapBox = box;
    return box;
  }

  async _capture(blob, duration) {
    const id = this.id;
    if (!id) return;
    if (!this.api) { this.onStatus("Motion capture needs the ComfyUI server (it runs SAM 3D Body on the GPU)."); return; }
    this.mcFile.disabled = this.mcAct.disabled = true;
    const job = this.opts.job?.();   // the progress card over the 3D view (web/ui/videoimport.mjs), when there is one
    const who = this.stage.selectedInfo?.()?.name || "this person";
    const say = (m) => { this.mcTake.textContent = m; if (!job) this.onStatus(m); };
    const frames0 = this.stage.state.shot?.frames || 0;
    try {
      if (job) {
        const secs = duration || await clipSeconds(blob);
        job.start(`Capture motion → ${who}`, capturePlan(Math.round((secs || 6) * 25)));
        job.step("upload");
      }
      const take = await captureTake(this.api, blob, { name: blob.name, duration, onStatus: (m) => {
        say(m);
        if (job && !/^Uploading/.test(m)) job.step("mocap", /Queued \(/.test(m) ? `Waiting for the GPU (${m.replace(/^Motion capture: /, "").replace(/…$/, "")})` : undefined);
      } });
      const msg = this.stage.setMocap(id, take, { start: this.stage.frame });
      if ((this.stage.state.shot?.frames || 0) !== frames0) this.opts.onTake?.(frames0);
      say(`${msg} Captured in ${Math.round(take.seconds)} s.`);
      this.onStatus(`${msg} Captured in ${Math.round(take.seconds)} s.`);
      job?.done(`${who} has the take`, `${msg} SAM 3D Body read it in ${Math.round(take.seconds)} s. It plays from the playhead, moving through your set as the performer did.`,
        this.opts.actions?.() || [], take.source ? [sourceLine(take.source)] : []);
      if (job) this.opts.actions?.()[0]?.run();
    } catch (e) {
      say(`Motion capture failed: ${e.message}`);
      this.onStatus(`Motion capture failed: ${e.message}`);
      job?.fail("Motion capture failed", `${e.message}. Try a clip where one person is clearly visible, head to toe.`, []);
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
    const mocap = this._buildMocap();
    const head = document.createElement("div");
    head.className = "head";
    this.title = Object.assign(document.createElement("strong"), { textContent: "Pose" });
    this.keyInfo = Object.assign(document.createElement("span"), { className: "note" });
    head.append(this.title, this.keyInfo,
      this._btn("Mirror L↔R", "Swap the left and right side of the pose at the playhead", () => this._do(() => this.stage.mirrorPoseAt(this.id), "Mirrored.")),
      this._btn("Clear key here", "Remove the pose key at the playhead", () => this._do(() => this.stage.clearPose(this.id), "Key removed.")),
      this._btn("Reset pose", "Remove every pose key: back to the plain walk / seat pose", () => this._do(() => this.stage.clearPose(this.id, true), "Pose reset.")));
    const sectLabel = (ic, text) => {
      const l = Object.assign(document.createElement("span"), { className: "lbl" });
      l.append(icon(ic, 14), text);
      return l;
    };
    const gallery = document.createElement("div");
    gallery.className = "sect";
    this.galleryRow = gallery;
    gallery.append(sectLabel("person-standing", "Poses"),
      ...Object.keys(POSE_PRESETS).map((n) => this._btn(n, `Apply “${n}” at the playhead`, () => this._do(() => this.stage.applyPosePreset(this.id, n), `${n} at frame ${this.stage.frame}.`))));
    // Interact: look at / talk / shake hands / hug / hold hands / point / pet / lead.
    const inter = document.createElement("div");
    inter.className = "sect";
    this.interRow = inter;
    this.target = document.createElement("select");
    this.action = document.createElement("select");
    for (const [v, l] of [["look_at", "Look at"], ["talk", "Talk to (face each other)"], ["handshake", "Shake hands"], ["hug", "Hug"],
      ["hold_hands", "Hold hands"], ["point_at", "Point at"], ["pet", "Pet (dog, cat, horse)"], ["lead", "Lead by the reins (horse)"], ["stop_look", "Stop looking"]])
      this.action.append(new Option(l, v));
    for (const el of [this.target, this.action]) el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.action.setAttribute("aria-label", "Interaction");
    this.target.setAttribute("aria-label", "With whom or what");
    inter.append(sectLabel("handshake", "Interact"), this.action,
      Object.assign(document.createElement("span"), { className: "note", textContent: "with" }), this.target,
      this._btn("Do it at the playhead", "Positions, faces and poses them for the interaction at the playhead",
        () => { const m = this.stage.interact(this.id, this.target.value, this.action.value); this.refresh(); this.onStatus(m || "Pick someone or something to interact with."); }));
    // The person's big actions lead the panel; each brings you to its section below (or starts a capture).
    const lead = Object.assign(document.createElement("div"), { className: "lead" });
    lead.setAttribute("role", "toolbar");
    lead.setAttribute("aria-label", "Person actions");
    // Pose in 3D: the body parts become handles in the stage view (rings on joints, dots on hands and feet). Key: P.
    this.pose3d = this._tool("move-3d", "Pose in 3D", "Click a body part in the view and turn it; drag a yellow dot to move a hand or foot (P)", () => {
      const on = this.stage.setPoseMode?.(!this.stage.poser?.active);
      this.pose3d.setAttribute("aria-pressed", String(!!on));
      this.onStatus(on ? "Pose in 3D: click a body part and turn the ring; drag a yellow dot to move a hand or foot. P or Esc to finish." : "Pose mode off.");
    });
    this.pose3d.setAttribute("aria-pressed", "false");
    lead.append(
      this.pose3d,
      this._tool("person-standing", "Pose", "Pick a pose from the gallery at the playhead", () => this.focusSection("pose")),
      this._tool("handshake", "Interact", "Look at, talk to, shake hands, hug, hold hands, point at, pet or lead", () => this.focusSection("interact")),
      this.mcFile, this.mcAct,
      this._tool("sliders-horizontal", "Joints", "Move any joint, fingers included; every slider keys the pose at the playhead", () => this.focusSection("joints")));
    const hint = Object.assign(document.createElement("div"), { className: "note",
      textContent: "Every slider keys the pose at the playhead. One key holds for the whole shot; add more at other frames and the pose eases between them (a head turn at 2 s). The video follows the clay pose." });
    this.el.append(head, lead, gallery, inter, mocap, hint);
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
    this.pose3d?.setAttribute("aria-pressed", String(!!this.stage.poser?.active));
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
