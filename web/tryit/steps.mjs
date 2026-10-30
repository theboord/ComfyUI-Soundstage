// Steps 2-5 for the try-it page: the real renders ComfyUI made from each preset scene (frames, finals, clay vs final,
// the joined cut). Media lives next to the page under r/ and is listed in r/renders.json; without it the section
// explains what each step does and says the renders aren't bundled.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};

let manifest = null;
const ready = fetch(new URL("./r/renders.json", import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((m) => { manifest = m; });

function video(src, { poster, muted = true, controls = true, loop = true } = {}) {
  const v = el("video", { src, poster, playsinline: true, preload: "metadata", loop, controls });
  v.muted = muted;
  return v;
}

/** A clay-vs-final wipe: the final sits over the clay, clipped by a slider; both play in sync. */
function wipe(shot) {
  const clay = video(shot.clay, { controls: false });
  const fin = video(shot.final, { controls: false });
  const top = el("div", { class: "wipe-top" }, fin);
  const box = el("div", { class: "wipe" }, clay, top, el("span", { class: "wl", text: "Clay stage" }), el("span", { class: "wr", text: "ComfyUI final" }));
  const range = el("input", { type: "range", min: "0", max: "100", value: "50", "aria-label": "Wipe between clay and final" });
  const set = () => { top.style.clipPath = `inset(0 0 0 ${range.value}%)`; box.style.setProperty("--split", `${range.value}%`); };
  range.addEventListener("input", set);
  set();
  const play = el("button", { type: "button", text: "Play both" });
  const sync = () => { if (Math.abs(fin.currentTime - clay.currentTime) > 0.08) fin.currentTime = clay.currentTime; };
  clay.addEventListener("timeupdate", sync);
  play.addEventListener("click", () => {
    if (clay.paused) { fin.currentTime = clay.currentTime; Promise.all([clay.play(), fin.play()]).catch(() => {}); play.textContent = "Pause"; }
    else { clay.pause(); fin.pause(); play.textContent = "Play both"; }
  });
  return el("div", { class: "wipe-wrap" }, box, el("div", { class: "row" }, play, range));
}

export async function showSteps(presetId) {
  await ready;
  const host = $("steps");
  if (!host) return;
  const scene = manifest?.scenes?.[presetId];
  host.replaceChildren();
  if (!scene) {
    host.append(el("p", { class: "muted", text: manifest
      ? "This scene is blocked on the stage but hasn't been rendered on the GPU for this page. Pick Riders at sunset, Police chase or a car scene to see the real ComfyUI output for every step."
      : "The rendered examples aren't bundled with this copy of the page." }));
    return;
  }
  const shots = scene.shots;
  let active = 0;
  const reviewHost = el("div");
  const pick = el("div", { class: "row", role: "group", "aria-label": "Shot to review" });
  const drawReview = () => {
    for (const [i, b] of [...pick.children].entries()) b.setAttribute("aria-pressed", String(i === active));
    reviewHost.replaceChildren(wipe(shots[active]));
  };
  shots.forEach((s, i) => pick.append(el("button", { type: "button", text: s.name, onclick: () => { active = i; drawReview(); } })));

  host.append(
    el("p", { class: "muted", text: scene.note }),
    el("div", { class: "step" },
      el("h4", {}, el("span", { class: "n", text: "2" }), "Frame: a photoreal first frame for every shot"),
      el("p", { class: "muted", text: "FLUX 3 Klein (or Krea 2 locked to the clay depth) paints each shot from its clay render, so the framing and who-stands-where stay as staged." }),
      el("div", { class: "frames" }, shots.map((s) => el("figure", {}, el("img", { src: s.frame, alt: `${s.name}: chosen first frame`, loading: "lazy" }),
        el("figcaption", { text: s.name }))))),
    el("div", { class: "step" },
      el("h4", {}, el("span", { class: "n", text: "3" }), "Motion: LTX-2.5 animates each frame, following the stage"),
      el("p", { class: "muted", text: "Camera move, actor paths and timing come from the stage; the sound is generated with the final." }),
      el("div", { class: "frames" }, shots.map((s) => el("figure", {}, video(s.final, { poster: s.frame }),
        el("figcaption", { text: s.kind === "draft" ? `${s.name} (draft)` : s.name }))))),
    el("div", { class: "step" },
      el("h4", {}, el("span", { class: "n", text: "4" }), "Review: wipe from clay to final"),
      el("p", { class: "muted", text: "Same blocking, same camera. Drag the slider to compare." }),
      pick, reviewHost),
    el("div", { class: "step" },
      el("h4", {}, el("span", { class: "n", text: "5" }), "Deliver: the whole cut as one video"),
      el("p", { class: "muted", text: "Every shot, trimmed and in order, joined with its sound in one click. The App also exports per-shot layer packs and an edit for Avid, Premiere, Resolve and Final Cut." }),
      el("div", { class: "cutbox" }, video(scene.cut, { poster: shots[0].frame, muted: false, loop: false }))),
  );
  drawReview();
}
