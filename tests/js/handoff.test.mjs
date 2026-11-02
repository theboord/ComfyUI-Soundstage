// node --test tests/js/   (✦ Hand-off: Open in ComfyUI, Download the graph, Send a move from your phone, Film a move)
import test from "node:test";
import assert from "node:assert/strict";

import * as O from "../../web/oneclick/oneclick.mjs";
import * as C from "../../web/oneclick/opencomfy.mjs";
import * as H from "../../web/oneclick/handoff.mjs";
import * as F from "../../web/vcam/film.mjs";

const WF = { nodes: [{ id: 1, type: "SaveVideo" }], links: [] };
const API = { 1: { class_type: "SoundstageRipple", inputs: {} }, 2: { class_type: "SaveVideo", inputs: {} } };

test("film: the clip code rides on the QR URL and is read back", () => {
  assert.equal(F.withClipCode("https://mac.local:8443/soundstage/vcam/viewfinder?vk=abc", "Code_123456"),
    "https://mac.local:8443/soundstage/vcam/viewfinder?vk=abc&clip=Code_123456");
  assert.equal(F.withClipCode("http://x/v", null), "http://x/v");
  assert.equal(F.clipCodeFrom("?clip=Code_123456&x=1"), "Code_123456");
  assert.equal(F.clipCodeFrom("?clip=<bad>"), null);
});

test("film: format, https rule and upload URL", () => {
  assert.equal(F.pickMime((m) => m === "video/webm"), "video/webm");
  assert.equal(F.pickMime((m) => m.startsWith("video/mp4")), "video/mp4;codecs=avc1.640028,mp4a.40.2");
  assert.equal(F.pickMime(() => false), "");
  assert.match(F.canFilm({ secure: false, media: true, recorder: true, code: "x" }), /https/);
  assert.match(F.canFilm({ secure: true, media: false, recorder: true, code: "x" }), /can't record/);
  assert.match(F.canFilm({ secure: true, media: true, recorder: true, code: null }), /QR/);
  assert.equal(F.canFilm({ secure: true, media: true, recorder: true, code: "abcdefgh" }), true);
  const u = new URL(F.uploadUrl({ code: "abcdefgh", device: "vf-1", dest: "nope", name: "move" }), "https://h");
  assert.equal(u.pathname, "/soundstage/vcam/clip");
  assert.equal(u.searchParams.get("dest"), "motion");
  assert.equal(F.fmtSecs(65), "1:05");
});

test("Open in ComfyUI: a canvas workflow opens as a new tab, an API graph through loadApiJson", async () => {
  const seen = [];
  const app = { loadGraphData: async (...a) => seen.push(["wf", ...a]), loadApiJson: async (...a) => seen.push(["api", ...a]) };
  assert.equal(await C.openGraph(app, { kind: "workflow", workflow: WF, prompt: API, name: "draft_00115_" }), "workflow");
  assert.deepEqual(seen[0].slice(2), [true, true, "✦ draft_00115_"]);
  assert.notEqual(seen[0][1], WF);                           // a copy: the tab can't edit what the server sent
  assert.equal(await C.openGraph(app, { kind: "api", prompt: API, name: "x" }), "api");
  await assert.rejects(C.openGraph({ loadGraphData() {} }, { kind: "api", prompt: API }), /Download/);
});

test("Download the graph: both files when both are inside", () => {
  assert.deepEqual(C.graphFiles({ name: "final 28", workflow: WF, prompt: API }).map((f) => f.name), ["final_28.workflow.json", "final_28.api.json"]);
  assert.deepEqual(C.graphFiles({ name: "a", prompt: API }).map((f) => f.name), ["a.api.json"]);
});

test("fetchGraph: the route's reason when there's no graph; a restart hint on an old server", async () => {
  const api = (status, body) => ({ fetchApi: async () => ({ ok: status === 200, status, json: async () => body }) });
  await assert.rejects(C.fetchGraph(api(200, { kind: null, why: "this file has no ComfyUI graph inside" }), "a.mp4"), /no ComfyUI graph/);
  await assert.rejects(C.fetchGraph(api(404, {}), "a.mp4"), /restart/);
  assert.equal((await C.fetchGraph(api(200, { kind: "api", prompt: API, nodes: 2 }), "a.mp4")).nodes, 2);
});

test("the hand-off cards need no GPU and apply to stills and clips", () => {
  for (const id of [...C.OPENCOMFY_IDS, ...H.HANDOFF_IDS]) {
    const s = O.getOneClick(id);
    assert.equal(s.group, "Hand-off"); assert.equal(s.gpu, false);
    assert.deepEqual(s.applies, ["still", "clip"]);
  }
});

test("phone clips: the event is heard, fetched and sent where the phone said", async () => {
  const target = new EventTarget();
  const api = {
    addEventListener: (t, f) => target.addEventListener(t, f), removeEventListener: (t, f) => target.removeEventListener(t, f),
    fetchApi: async (path) => { assert.match(path, /^\/view\?filename=phone_1.mp4&subfolder=soundstage_private%2Fphone&type=input/);
      return { ok: true, blob: async () => new Blob([new Uint8Array(10)], { type: "video/mp4" }) }; },
  };
  const got = [];
  const off = H.listenPhoneClips(api, (info) => got.push(info));
  target.dispatchEvent(Object.assign(new Event("soundstage.vcam"), { detail: { type: "pose" } }));
  target.dispatchEvent(Object.assign(new Event("soundstage.vcam"), { detail: { type: "clip", ref: "r", name: "phone_1.mp4", subfolder: "soundstage_private/phone", kind: "input", dest: "performance", device: "vf-1" } }));
  off();
  assert.equal(got.length, 1);
  const where = [];
  const f = await H.landPhoneClip(got[0], { api, say() {}, ask: (x) => where.push(["ask", x.name]), performance: (x) => where.push(["performance", x.name]) });
  assert.equal(f.name, "phone_1.mp4");
  assert.deepEqual(where, [["performance", "phone_1.mp4"]]);
  await H.landPhoneClip({ ...got[0], dest: "footage" }, { api, say() {}, ask: (x) => where.push(["ask", x.name]) });
  assert.deepEqual(where.at(-1), ["ask", "phone_1.mp4"]);       // no footage hook: the "What is this video for?" card
});

test("clipCode is minted once; an old server gives none", async () => {
  let n = 0;
  const api = { fetchApi: async () => { n++; return { ok: true, json: async () => ({ code: "Code_abcdefgh" }) }; } };
  assert.equal(await H.clipCode(api), "Code_abcdefgh");
  assert.equal(await H.clipCode(api), "Code_abcdefgh");
  assert.equal(n, 1);
  assert.equal(H.destWords("footage"), "Footage");
});

test("an API graph is framed after it opens", async () => {
  let fitted = null;
  const app = { graph: { _nodes: [{ pos: [100, 130], size: [300, 100] }, { pos: [900, 600], size: [200, 80] }] },
    canvas: { ds: { fitToBounds: (b) => (fitted = b) }, setDirty() {} }, loadApiJson: async () => {} };
  await C.openGraph(app, { kind: "api", prompt: API, name: "x" });
  assert.deepEqual(fitted, [100, 100, 1000, 580]);
  assert.equal(C.nodeBounds([]), null);
});
