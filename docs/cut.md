# Cut tab

The Cut tab is the editing timeline on the SoundstageStage node: picture on V1, temp sound on
A1..An. It plays the coverage as a live animatic at 24 fps with the sound mixed in sync, and it
exports to every NLE in that NLE's best format. Each shot also gets a mix WAV that goes back into
LTX as audio conditioning for its final render.

Each picture clip plays the best rung it has: Final, then Draft (`<video>`), then the Look still,
then live clay from the stage. A clip pinned to a take plays that take instead
([Edit from the timeline](#edit-from-the-timeline)). Exports use the same order. Anything that isn't a
Final goes out as a stand-in with a relink note.

## Files

| File | What it is |
| --- | --- |
| `web/cut/strip.mjs` | `export class ShotStrip`: the docked shot strip, plus pure `syncCut` / `appendSetups` / `presetCamera` |
| `web/cut/cut.mjs` | `export class CutPanel`: the UI (viewer, transport, V1 + audio tracks, inspector, shot bin) and the WebAudio engine |
| `web/cut/timeline.mjs` | Edit model, pure functions: picture edits, cut on action, audio clips, lanes, sync-lock ripple |
| `web/cut/fx.mjs` | Transitions, keys, auto-duck, loudness, beats, assembly from the lining, subtitles (Milestone 19) |
| `web/cut/gen.mjs` | Generate / import sound in place from the Cut editor |
| `web/cut/editlink.mjs` | Edit from the timeline, the Cut side: a clip's link, the Edit in… items, the hold, the menu, ✎ and `E` (no App imports) |
| `web/cut/editlink_app.mjs` | Edit from the timeline, the App side: the trip, the jumps, ↩ Back to the cut, take detection, Replace in cut |
| `soundstage/cut/render.py` | Render the cut to MP4 / ProRes / 9:16 with transitions, titles and the mix at a loudness target |
| `web/cut/exporters.mjs` | Browser-side exports: EDL, Avid locators, Premiere XML, FCPXML, OTIO, RELINK.txt |
| `soundstage/cut/export.py` | Python twin of the two files above, byte for byte (the test diffs them) |
| `soundstage/cut/aaf.py` | AAF for Avid (needs `pyaaf2`) |
| `soundstage/cut/mix.py` | Audio mixdown: the cut mix and one WAV per shot, plus `index.json` |
| `soundstage/cut/writer.py` | `write_cut()`: writes the whole export folder |
| `soundstage/nodes_cut.py` | `NODES = [SoundstageCutExport, SoundstageCutShotAudio]` |
| `web/cut/demo.html`, `demo_project.json`, `demo_media/` | Stand-alone harness with a 2D clay stand-in and two SFX clips |
| `tests/js/cut.test.mjs`, `tests/js/strip.test.mjs`, `tests/test_cut.py` | Tests |
| `tests/js/editlink.test.mjs`, `tests/test_cut_editlink.py`, `tools/qa/editlink_click.mjs` | Edit from the timeline: tests and the headless click-through |

## Shot strip (docked under the stage)

`web/cut/strip.mjs` exports `ShotStrip`: a compact (about 90 px) timeline of the cut that lives
under the viewport all the time. Each clip is one stage setup (`stage.state.shots`), with a filmstrip
of its best render (Final › Draft › Look) or live clay.

- **Click** a clip: that setup becomes the stage's active shot, and the stage jumps to its frame. Edit it right there.
- **Drag** a clip to reorder; the others slide out of the way. **Drag an edge** to trim; the stage shows the frame you're trimming to.
- **+ Shot**: a copy of the current camera, or a new angle (Master, Wide, Two-shot, OTS A/B, Single A/B, Insert, POV).
  Angles are framed on the first two actors where the new clip will be. A move gets a key at each end, so the camera follows.
  Cameras stay on the current camera's side of the line.
- **Right-click** (or the ⋯ handle): edit, duplicate setup, duplicate clip, split at the playhead,
  remove from cut (the setup stays), delete setup.
- **Space / J K L / ← →** play and scrub the cut on the stage itself. **↑ / ↓** go to the previous / next clip.
  **⌫** removes the clip under the playhead from the cut. **⌘D** duplicates its setup, **⌘Z** undoes. The wheel scrolls; ⌘-wheel zooms.
- **Editor** opens the full Cut view (audio tracks, NLE export, detailed trims). Both edit the same saved cut.
- **Sync, both ways:** a new setup (from + Shot, the stage's New setup, or the Advisor) is appended to
  the cut. It continues the action, timed by the Advisor's `seconds` when it has them, else 3 s. A
  deleted setup leaves the cut. A setup removed from the cut on purpose is remembered in
  `excluded_shots`, so it isn't added back.
- **Advisor → cut:** "Add as setups" shots land in the cut in the Advisor's order and timing. This
  works on its own; the `onShotsAdded` option on `AdvisorPanel` makes it immediate.
- Narrow App panel: labels collapse to icons under 460 px; the total and Undo hide under 320 px.

## Mounting (integrator)

The panel is mounted in `web/soundstage.js`. What it relies on:

```js
import { ShotStrip, readSaved } from "./cut/strip.mjs";

// One saved cut for the strip and the full editor: {cut, audio, audio_tracks, excluded_shots}.
const loadCut = () => readSaved(node.properties?.ss_cut);
const saveCut = (s) => { node.properties = node.properties || {}; node.properties.ss_cut = s; };

const stripHost = document.createElement("div");
view.after(stripHost);  // a SIBLING of the stage view (not inside it), so tabs that hide the view don't hide the strip
const strip = new ShotStrip(stripHost, {
  stage, api,
  getRenders: () => shotRenders,             // {setupId: {look, draft, final}}
  onSelect: (setupId) => { /* e.g. showView("stage") if another tab is open */ },
  onStatus: (m) => (status.textContent = m),
  load: loadCut, save: (s) => { saveCut(s); if (!cutView.hidden) cut.refresh(); },
  onOpenEditor: () => showView("cut"),
  renderPreviewFrame: (id, f) => { const p = stage.state.active_shot; stage.state.active_shot = id;
    try { return stage.renderFrameTo("clay", f); } finally { stage.state.active_shot = p; } },
});
// Advisor: also pass onShotsAdded so its shots land in the cut at once, in its order and timing
//   new AdvisorPanel(advisorView, { api, stage, onStatus, onShotsAdded: (ids, shots) =>
//     strip.appendShots(ids, { seconds: Object.fromEntries(ids.map((id, i) => [id, shots[i].seconds])) }) });

const cut = new CutPanel(cutView, {
  // Shots and renders from the stage/ladder, plus everything onChange gave you last time.
  getProject: () => ({ ...buildCutProject(), ...loadCut() }),
  renderPreviewFrame: (shotId, frame) => /* that shot's camera, that frame, as a canvas */,
  // Persist cut AND audio, or the temp sound is gone when the workflow reloads.
  onChange: (p) => { saveCut({ ...loadCut(), cut: p.cut, audio: p.audio, audio_tracks: p.audio_tracks }); strip.refresh(); },
});
// Server-sent SFX (PromptServer.send_sync("soundstage.sfx", clip)) -> the panel:
api.addEventListener("soundstage.sfx", (e) => cut.addAudioClip(e.detail));
```

- `refresh()` re-reads `getProject()`. When the host returns `cut`, `audio` or `audio_tracks` as
  arrays, those are used as they are; when it leaves one out, the panel keeps its own. If there is no
  cut at all, the panel builds a first assembly and reports it through `onChange`.
- Call `cut.resize()` when the tab is shown, `cut.stop()` when it's hidden, and `cut.refresh()` when
  renders arrive.
- Every pointer, key and wheel event inside the panel calls `stopPropagation`. Wheel events over the
  timeline go through a capture-phase router keyed on `canvas.__soundstageCut`. Keys are ignored while
  you type in the inspector's fields.
- To export from the graph, send `cut.getProject()` (JSON) into `SoundstageCutExport.project_json`.

### Audio API (for the SFX builder)

```js
const id = cut.addAudioClip({
  url: "/view?filename=door_slam_00001.wav&subfolder=sfx&type=output",  // what the browser fetches
  path: "sfx/door_slam_00001.wav",   // optional: output-relative or absolute; the server mixdown prefers it
  label: "Door slam",                // clip name in every NLE
  start_frame: 120,                  // record frame from the head of the cut (default: the playhead)
  track: 2,                          // A2 (default: the first track that is free there)
  in: 0, out: 36,                    // source frames, out exclusive (default: the whole file, filled in on decode)
  gain_db: -3, fade_in: 4, fade_out: 12,
  meta: { prompt: "heavy wooden door slams", model: "..." },  // kept as is, never exported
});
cut.addAudioClips([...]);
cut.updateAudioClip(id, { gain_db: -6 });
cut.removeAudioClip(id);
cut.getAudioClips();
cut.setTrack(2, { mute: true });   // or { solo: true }, { name: "Foley" }
window.dispatchEvent(new CustomEvent("soundstage.sfx", { detail: clip }));  // or detail: [clips] / { clips }
```

`addAudioClip` is one undoable edit and fires `onChange`. A clip needs a `url` or a relative `path`
to play in the browser. An absolute server path still exports and mixes, but the panel can't play it
or draw its waveform.

## Project contract

```jsonc
{
  "name": "Diner Night v1",       // sequence, folder and file name
  "fps": 24,                      // 24 (default) | 23.976 | 25 | 29.97 | 30 ...; timecode is always non-drop
  "width": 1920, "height": 1080,
  "shots": [{
    "id": "sc1_ots_a", "name": "SC1_OTS_A", "frames": 192,
    "scene_name": "SC1 Diner",    // setups that share a scene_name share actors and timing
    "setup": "OTS A",
    "scene_offset": 0,            // scene-clock frame of this shot's frame 0
    "renders": { "look": "/view?...png", "draft": "/view?...mp4", "final": "/view?...mp4", "clay": "/view?...mp4" },
    "notes": "push in slower",    // string or [strings]: marker at the clip's first frame
    "markers": [                  // Advisor notes at a shot frame (only exported if the cut includes that frame)
      { "frame": 80, "text": "eyeline drifts", "color": "Yellow", "user": "ADVISOR" }
    ]
  }],
  "cut": [ { "shot_id": "sc1_master", "in": 0, "out": 60, "notes": "optional" },   // gapless picture
           { "shot_id": "sc1_ots_a", "in": 60, "out": 110,
             "uid": "c4k2x9q",                                   // optional: a stable clip id (Edit from the timeline)
             "take": { "url": "/view?filename=ots_a_00003_.mp4&subfolder=soundstage&type=output",
                       "rung": "final", "version": 2, "at": "14:02" },   // optional: the take this clip plays
             "versions": [ { "url": "/view?filename=ots_a_00001_.mp4&subfolder=soundstage&type=output",
                             "rung": "final", "version": 1 } ] } ],      // optional: the takes it played before
  "audio": [ { "id": "rain", "track": 1, "url": "...", "path": "...", "start_frame": 0, "in": 0, "out": 96,
               "frames": 96, "gain_db": -6, "fade_in": 12, "fade_out": 24, "label": "Rain on glass", "meta": {} } ],
  "audio_tracks": [ { "track": 3, "name": "", "mute": true, "solo": false } ],
  "excluded_shots": ["shot_x"]   // setups taken out of the cut on purpose (the strip won't re-add them)
}
```

- Record time runs from **01:00:00:00**. Picture is the gapless running total of `out - in`.
  Audio sits at `start_frame`, can leave gaps, and can run past the picture: the sequence is then that
  much longer.
- Normalising (JS `normalizeProject`, Python `normalize_project`) clamps every range and fade, rounds
  gain to 0.1 dB in [-60, +24], and drops cut events whose shot is missing. An audio clip with no `out`
  and no `frames` gets them filled in when the browser decodes the file. Until then exports leave it out.
- Marker colours: Red, Green, Blue, Cyan, Magenta, Yellow, Black, White (anything else is Red).
- **Pinned clips.** A clip with `take` plays that file (its `rung`: `final`, `draft`, `look`, or `clay` with no `url`)
  in the viewer, the strip, every export, the AAF and the server render. A clip without `take` plays its shot's best
  render. `versions` keeps the takes a clip played before (newest 12). `uid` is kept when valid and unique (a split's
  copy loses it) and never made up by normalising. The three fields are optional: a cut without them normalises and
  exports exactly as before. JS `layout()` / Python `layout()` apply the pin (`clipShot` / `clip_shot`), so every reader
  of a layout row gets it.

## Cut on action

Two different setups with the same `scene_name` are coverage of one moment. Shot frame `f` sits on
the scene clock at `scene_offset + f`. With **Cut on action** on, inserts, moves and overwrites match
the scene frame and trims snap to it. Edits get a green diamond (on action) or an orange one (jump).
**M** re-matches the selected clip. The per-shot audio mix uses the same clock (see below).

## Editing

| Key / gesture | Action |
| --- | --- |
| Space, click the viewer | Play / stop (picture + sound at 1×) |
| J / K / L | Shuttle (2×, 4×, 8× on repeat; picture only, no sound) |
| ← / → (⇧ = 1 s), ↑ / ↓, Home / End | Step, previous / next edit, head / tail |
| I / O / G, X | Marks, clear marks, extract I/O |
| B or ⌘B | Split: the selected audio clip, else the picture at the playhead |
| ⌫ / Delete | Remove the selected audio clip; ripple delete the selected picture clip; with nothing selected, extract I/O |
| ⌘Z / ⇧⌘Z | Undo / redo (picture, audio and mute/solo, 200 steps) |
| = / - / \\, wheel | Zoom in / out / fit; ⇧-wheel or horizontal swipe scrolls |
| Drag a picture clip / its edge / ⌥-drag an edit | Reorder / ripple trim / roll |
| Drag an audio clip | Slide in time; drag up or down to change track (a new track below the last). Snaps to edits, the playhead, the in mark and other clips' edges |
| Drag an audio clip's edge | Trim (a head trim keeps the sound in sync) |
| Drag the small handles at an audio clip's top corners | Fade in / fade out |
| [ / ] | Gain −1 / +1 dB on the selected audio clip (or type it in the inspector) |
| M / S in a track header | Mute / solo (solo wins, like a desk) |
| Click a shot in the bin, ⇧-click, drag to the track | Splice in, overwrite, insert |

- **Sync lock** (on by default): ripple edits on the picture (ripple delete, extract, trims, splice,
  insert, reorder) move the audio that starts after them. On a reorder, audio rides with the clip it
  starts under.
- Waveforms are drawn with gain and fades applied. Clips on muted tracks are dimmed.
- While sound is playing, WebAudio's clock drives the picture. If that clock stalls (no output device,
  a background tab), the picture falls back to wall time.

## Transitions, fades, keys, sound and titles (Milestone 19)

Code: `web/cut/fx.mjs` (pure rules), `web/cut/cut.mjs` (UI), `web/cut/gen.mjs` (generate / import sound),
`soundstage/cut/render.py` (the render). Tests: `tests/js/cut_m19.test.mjs`, `tests/test_cut_m19.py`.

**Tracks.** V2 (title cards) above V1; a SUBS lane under V1; A1 Dialogue, A2 SFX, A3 Music, A4 Ambience (named by
role; a project's own names, such as docs/audio.md's DX1/FX1/MX1, win).

| Key / gesture | Action |
| --- | --- |
| S (or B) | Split at the playhead |
| ⌘-drag a clip, `,` / `.` (⇧ = 5) | Slip: same length and place, other frames |
| Drag a Transitions chip onto a cut | Dissolve, dip to black / white, wipe. On the head it is a fade up, on the tail a fade out |
| Click a chip, or T | The transition (T: a dissolve) on the cut nearest the playhead |
| Click a transition bar | Inspector: type, length, Remove (⌫ removes it too) |
| R, or Keys | Rubber bands: click a clip's level (audio) or opacity (V1) line to add a key, drag it, ⌥-click deletes |
| + Title, drag on V2 | A title card (Card on black, Lower third, Centre, Credit), text, length and fades in the inspector. **Credit** is a small lower-left line with a soft shadow and no band: the on-screen credit a CC BY licence asks for, or a production super. In a 2.39 picture inside 16:9 it sits in the lower letterbox bar |

**Where a transition sits.** A dissolve or wipe is centred on the cut and overlaps the clips, so it uses their
handles: the outgoing clip runs past its out point, the incoming one starts before its in point. When one side is
short it shifts; when both are short it is shortened, and the bar turns orange and the status line says how much
fitted. With no handles at all (a clip using its whole take next to one starting at frame 0) a dissolve can't go
there; use a dip, which fades each clip's own frames and needs no handles. No side takes more than half its clip.

**Sound after generation.**
- *Generate* (SFX → A2, Music → A3, Dialogue → A1): one small prompt of the App's own node (Soundstage · Sound
  Effect / Music Cue / Dialogue Line, open-weights engines: LTX-2.5 audio, Chatterbox), with the node's prompt guard.
  The clip lands at the playhead. Dialogue as `MARA: the line` sets the speaker. *Import…* puts a file on the track
  its name suggests.
- *Auto-duck*: music on A3 dips −12 dB under each dialogue line on A1 (6 frames attack before it, 12 release after
  it; lines closer than that stay ducked between). It writes the music clip's `duck` keys (drawn in amber), kept apart
  from your own `keys`, so a re-duck replaces only its own.
- *Beats*: the selected music clip's (or the first on A3) tempo and beats, by onset detection; ticks on the ruler,
  trims snap to them. *Cuts → beat* rolls each cut onto the nearest beat within 6 frames (length unchanged).
- *Loudness*: the render's target, Social −14 LUFS (−1 dBTP), EBU R128 −23 LUFS (−1 dBTP) or ATSC A/85 −24 LKFS
  (−2 dBTP). *Measure* reads the tracks' integrated loudness (BS.1770) in the browser.

**Assemble scene** builds a first cut from the ScriptSync lining: the wide (or master) for action, an insert when
one is lined on that action line, the speaker's single (then their OTS, the two-shot) for their lines, cutting on
line ends. Each line lasts as long as it does in the take that covers the whole scene. Subtitle cues come with it.
**Subtitles** rebuilds the cues from the dialogue clips' typed lines (`meta.line`); no speech recognition.
**Burn in** draws them into the render.

**Render** (`POST /soundstage/cut/render`, `soundstage/cut/render.py`) writes `output/soundstage_cuts/<name>_<time>.mp4`
(H.264 + AAC), `.mov` (ProRes 422 HQ + 24-bit PCM) or `<name>_9x16_<time>.mp4` (1080×1920, centre crop; the titles
and subtitles are laid out for the phone):
- picture: each clip's best render (Final › Draft › Look › clay capture; a titled slate where none exists), trimmed
  with the handles its dissolves need; dissolves and wipes with ffmpeg's `xfade`, dips and fades with `fade`, opacity
  keys over black; titles and subtitles as Pillow-drawn overlays (no `drawtext` needed);
- sound: every audible track with gain, fades, keys and duck (the same mixdown as the LTX per-shot WAVs), plus each
  Final's own sound, crossfaded with the picture; then one linear gain to the target (measured with ffmpeg's BS.1770)
  and a 4×-oversampled true-peak limiter, with 0.7 dB of headroom for AAC.

**Project contract additions** (all optional; a project without them exports byte for byte as before):

```jsonc
"cut": [{ "shot_id": "a", "in": 0, "out": 60, "trans": { "type": "dissolve", "frames": 12 },   // into this clip
          "opacity": [[0, 1], [12, 0.4]] }],                                                     // clip frame, 0..1
"fade_out": { "type": "dip_black", "frames": 24 },
"audio": [{ "...": "...", "keys": [[0, 0], [48, -6]], "duck": [[90, 0], [96, -12]] }],          // clip frame, dB
"titles": [{ "id": "t1", "text": "DINER NIGHT", "start_frame": 0, "frames": 72, "style": "card", "fade_in": 6, "fade_out": 6 }],
"subtitles": [{ "id": "s1", "start_frame": 100, "end_frame": 160, "text": "Then why bring this one?", "speaker": "MARA" }],
"burn_subtitles": false
```

**Exports.**

| Format | Transitions and fades | Keys | Titles / subtitles |
| --- | --- | --- | --- |
| EDL | `D` dissolves, `W001` wipes, dips and fades through `BL`; dip to white noted | Level keys as `* SOUNDSTAGE LEVEL`, opacity as a comment | Title comments; `<name>.srt` / `.vtt` |
| Premiere XML | Cross Dissolve, Dip to Color Dissolve (black / white), Edge Wipe; head `start-black`, tail `end-black` | Audio Levels and Opacity keyframes | Titles as Text generators on V2 |
| FCPXML | Every kind as FCP's Cross Dissolve at its real place and length | `adjust-volume` and `adjust-blend` keyframes | Basic Title on lane 1 |
| OTIO | `Transition.1` (SMPTE_Dissolve / SMPTE_Wipe) with in/out offsets | In `metadata.soundstage` | Generator clips on a V2 track |
| AAF | Not carried (use the EDL in Avid) | No | No |

Not verified yet: import of the transitions, keys and titles into the real NLEs (the files parse, the EDL record
times stay contiguous, the Python and browser writers agree byte for byte).

**For the director.** `CUT_ACTIONS` / `runCutAction(panel, name, args)` in `web/cut/cut.mjs` list and run every edit
(split, ripple delete, trim, roll, slip, move, transition, keys, generate audio, auto-duck, beats, assemble,
subtitles, titles, loudness, render). The panel is `node.ssCut`.

## Motion graphics on V3

Code: `web/cut/gfx.mjs` (templates, timing, the viewer painter), `soundstage/cut/gfx.py` (the Python twin and the
render painter), `soundstage/cut/gfx_sfx.py` (the sound pack), `web/cut/cut.mjs` (V3 lane, inspector, viewer drag).
Tests: `tests/js/cut_gfx.test.mjs`, `tests/test_cut_gfx.py`; QC: `tools/qa/gfx_sfx_qc.py`.
The design comes from `share/Commercial/DESIGN_SYSTEM.md` v1.1 (§4 grid, §5 type, §6 colour, §7 surfaces, §8 motion,
§9 layouts, §13 sounds).

**Templates:** title (L7), kinetic (T2 slam + T3 swap, one word per 12-frame beat), lower (L6), callout (L8: zoom
z* = min(0.6·1920/(w+96), 0.5·1080/(h+96), 2) on `glide` with exponential scale, the ring at f10 on a spring, the
chip 4 f later, an optional cursor click), pip (L2), dual (L3 even / stagger / stack), device (L4 monitor / phone,
no plane break yet), split (L5: the divider 0 → 960 in 14 f on `glide`, hold, then → 1920 in the last 24 f on `swift`),
endcard (L10, a static logo: the clapper animation waits for Mike's OK). Geometry is in 1920×1080 design pixels and
scales to the project.

**One timing, two painters.** `stateAt(g, f)` (JS) and `state_at(g, f)` (Python) return the same draw ops for every
frame: `tests/js/fixtures/gfx_states.json` pins 336 frames across every template and look, and both suites compare
them exactly (`node tests/js/cut_gfx.test.mjs --update` rewrites it after a deliberate change). The viewer draws the
ops with canvas 2D; the render draws them with Pillow: raqm layout when Pillow has it (the pod does: GPOS kerning),
tracking by prefix advance so kerning survives. Type is Space Grotesk (the App's vendored OFL face). Inter Tight, the
spec's face, is not vendored.

**Render path.** With graphics, `render_cut` writes the picture so far (cut, transitions, Film Finish) to a lossless
FFV1 file, paints every frame that has a graphic (windows decode their own clip and rung; a named rung that is not
rendered shows a slate saying so), then lays the V2 titles, subtitles and the mix on that, as before. Frames that move
more than 4 px or scale more than 2 % are averaged from 4 sub-frames (180° shutter); `spec.gfx_motion_blur: false`
turns that off. The result reports `graphics: {frames, graphics, raqm, subframes}`.

**Sounds.** `sfxCues(g)` gives one designed sound per event (SFX-01 tick, -02 swap, -03 thump, -04 whoosh with up 2 /
down 3 semitone variants, -05 whoosh out, -06 riser ending on the zoom's sync frame, -07 ping, -08 click, -09 air
pass, -12 puff, -15 sonic logo), panned left / centre / right by the element's x. The Cut lays them on A2 tagged
`meta.gfx` and re-lays them on every graphics edit (`withGfxClips`), so they never stack. Files are synthesised once by
`GET /soundstage/cut/gfx_sfx` into `output/soundstage_sfx/gfx/` with a `MANIFEST.json` (recipe, pan, length, peak,
sha256): 48 kHz 24-bit stereo, peak −1 dBFS, the clip gain sets the §13 level (e.g. −27 dB on a tick for −28 dBFS).

**Contract:**

```jsonc
"graphics": [{ "id": "g1", "template": "pip", "start_frame": 48, "frames": 96, "variant": "br",
               "text": "Live clay", "text2": "", "text3": "", "blue": "", "x": 0, "y": 0,
               "color": "#F0EFED", "accent": "#28AAFF", "sfx": true,
               "a": { "shot_id": "s2", "in": 0, "rung": "auto" } }]    // callout: "rect": [x, y, w, h, radius]
```

**Director:** `cut.graphic`, `cut.update_graphic`, `cut.remove_graphic` in `CUT_ACTIONS`.

**Not done:** the device plane break and through-the-screen transition (X5), the clapper animation, tracked tags,
counters, the paper inversion, proper 9:16 layouts (a 9:16 render fits the 16:9 layout to the width), and NLE export
of graphics.

## Exports: one folder for every NLE

`SoundstageCutExport` writes **`output/soundstage_cuts/<name>/`**. It is the same folder on every
export (overwritten), so paths stay predictable:

| File | For | What |
| --- | --- | --- |
| `<name>.aaf` | Avid | Composition with TC, V1, one audio track per lane, notes as Avid locators. Linked media, not embedded. Needs `pyaaf2` |
| `<name>.edl` | Avid, also Premiere / Resolve | CMX3600: V events, then audio events (channels A, A2, A3...). Reel = name (8 characters, or 32 for Avid File_32) |
| `<name>_avid_locators.txt` | Avid | Marker file in the ~/Notes2Markers layout, Latin-1: notes, Advisor markers, Cyan RELINK flags |
| `<name>_premiere.xml` | Premiere Pro | Final Cut Pro 7 XML (xmeml v5): V1 and audio tracks, levels, fades as Cross Fade (+3dB), markers |
| `<name>.fcpxml` | Resolve, Final Cut Pro | FCPXML 1.10: picture spine, audio as connected clips on lanes −1, −2..., `adjust-volume` with fades, markers, relink `<note>`s |
| `<name>.otio` | Resolve, OTIO tools | V1 plus Audio tracks with gaps; gain and fades in `metadata.soundstage` |
| `RELINK.txt` | everyone | Each clip still on a stand-in: its rung, its media and what to do |
| `project.json` | Soundstage | The normalised project as exported |
| `audio/` | LTX | `<name>_mix.wav`, `<shot_id>_mix.wav` per shot, `index.json` |

The panel's export buttons download the same text files from the browser. Paths are relative there;
the node writes absolute paths under the ComfyUI output folder. AAF and the WAVs are server-only.

- **Media:** a `/view?filename=F&subfolder=S&type=T` URL becomes `S/F` under the matching ComfyUI
  folder. A clay-only shot with no `renders.clay` capture is offline as `<shot name>.mov`, so the NLE
  shows it as missing media ready to relink.
- **Overlapping audio on one track** is exported as an extra lane (`A1b`), because no NLE track can
  overlap.
- **Locators:** Avid keeps one locator per frame and track, so notes that land on the same frame are
  merged into one, joined with " | ". The EDL LOC lines and the AAF follow the same rule.
- **Gain and fades:** the EDL carries them as `* SOUNDSTAGE AUDIO:` comments, the AAF not at all (set
  them in Avid), Premiere XML / FCPXML / OTIO for real.
- **AAF fallback:** the pod's venv has no `pyaaf2`. Without it the node writes everything else and
  says so in its UI text. Avid then uses the EDL + locator .txt. To get the AAF, install it on the
  pod (pure Python, no build), with Mike's OK:

```bash
/path/to/ComfyUI/venv/bin/pip install pyaaf2
```

### Per-shot audio for LTX

`audio/<shot_id>_mix.wav` is 48 kHz / 24-bit stereo. Sample 0 is shot frame 0, and it runs exactly
`shot.frames` frames. Frames are filled from the cut mix in two passes:

1. where that shot itself is cut in;
2. where another setup of the same scene plays that moment, via the scene clock.

So an OTS that is only cut in for two seconds still gets the scene's sound for its whole take.
Frames the cut never covers are silent. Muted tracks are left out (solo/mute as in the panel).
`audio/index.json`:

```jsonc
{ "version": 1, "cut": "...", "fps": 24, "sample_rate": 48000, "bit_depth": 24, "channels": 2, "has_audio": true,
  "cut_mix": { "file": "audio/<name>_mix.wav", "path": "...", "frames": 288, "samples": 576000, "peak_dbfs": -4.1 },
  "shots": [ { "shot_id": "sc1_ots_a", "name": "...", "file": "audio/sc1_ots_a_mix.wav", "path": "...", "frames": 192,
               "samples": 384000, "duration_s": 8.0, "covered": [[0, 60, "scene"], [60, 110, "own"]],
               "silent": false, "peak_dbfs": -6.2 } ],
  "problems": [ { "audio_id": "...", "label": "...", "source": "...", "error": "..." } ] }
```

`SoundstageCutShotAudio(cut, shot_id)` loads one of these as ComfyUI `AUDIO` (+ frames, fps) for the
LTX audio input. `cut` is the export folder or the cut name. Decoding uses soundfile, then PyAV, then
the stdlib `wave` module, all of which the pod has. Mono sources are duplicated to both channels with
no pan law.

## Importing, NLE by NLE

**Avid Media Composer**
1. Bin › File › Import, choose `<name>.aaf`: a sequence appears with offline master clips.
2. Without the AAF, open `<name>.edl` in EDL Manager, or import it to a bin, to build the sequence.
3. Load the sequence in the Record monitor. In the Markers window, right-click › Import Markers and
   choose `<name>_avid_locators.txt`.
4. Relink the offline clips to the renders: Clip › Relink by name, or AMA/Source Browser link the
   `output/` folder first. The RELINK locators and `RELINK.txt` list what is still a stand-in.

**Premiere Pro**
1. File › Import, choose `<name>_premiere.xml`. Premiere builds a bin and the sequence with audio tracks.
2. Locate any offline media (Link Media › choose the output folder). The clip comments carry the
   relink note.
3. Premiere does not import FCPXML; use this XML, or the EDL as a fallback.

**DaVinci Resolve**
1. File › Import › Timeline, choose `<name>.fcpxml` (or `<name>.otio`). Leave "Automatically import
   source clips into media pool" on.
2. Relink offline clips from the Media Pool (Relink Selected Clips › the output folder).

**Final Cut Pro**
1. File › Import › XML, choose `<name>.fcpxml`. The audio comes in as connected clips under the
   picture, and stand-ins carry a note.

## Tests

```bash
node --test tests/js/cut.test.mjs
```

```bash
cd tests && python -m pytest test_cut.py -q
```

The JS tests cover:
- timecode math, EDL columns and contiguity, the audio events and their comments;
- the locator layout and one-per-frame merging;
- Premiere XML structure and file reuse, OTIO audio tracks, FCPXML lanes, fades and stills;
- every picture and audio edit operation, sync-lock ripple, lanes and mute/solo.

The Python tests:
- cover the same EDL / OTIO / FCPXML / xmeml / locator checks, with XML parsed by ElementTree;
- check the export folder;
- check the mixdown sample by sample: own and scene-clock coverage, gain, resampling, mute, a
  missing file;
- write the AAF and read it back;
- diff every text export against the JS one byte for byte (needs `node`).

With `opentimelineio`, `otio-cmx3600-adapter`, `otio-fcpx-xml-adapter` and `otio-aaf-adapter`
installed, the EDL, FCPXML and AAF are also read back through OTIO's own readers. All of that passes
(27 tests; OTIO 0.18.1, pyaaf2 1.7).

Edit from the timeline: `node --test tests/js/editlink.test.mjs` (the pins through normalize, layout and every
exporter, the link per clip type, the menu table, the hold, Replace as one Undo, versions, new takes, the App's link
resolver and prompt-tag reader) and `python -m pytest tests/test_cut_editlink.py -q` (the Python twin, the server
render's file, one AAF master per file, and byte parity with the browser writers for a pinned cut). The headless
click-through at the Cut level (no ComfyUI): `CHROME=<chrome> node tools/qa/editlink_click.mjs`.

Harness: serve `web/` over HTTP and open `/cut/demo.html`:

```bash
python3 -m http.server 8779 --directory web
```

## Not verified yet

Import into the real apps (Avid, Premiere, Resolve, FCP) has not been tested. The EDL, FCPXML and
AAF pass OTIO's readers, the XMLs parse, and the OTIO loads in opentimelineio. Drop-frame timecode is
not supported. AAF carries no clip gain or fades.

## Cut → one video

Under the shot strip:

- **Cut → one video** joins the whole cut into one MP4, with sound, in `output/soundstage_cuts/`.
  - Each clip is trimmed to its in/out frames. In/out sit on the shared scene clock, and every setup renders the full take, so the trim is exact.
  - Each clip uses its best render: Final + sound › Final › Final · audio-driven › Draft › Previz › Look still.
  - A shot with no render yet becomes a black slate of the right length (titled when ffmpeg has `drawtext`), so the cut's timing always holds.
  - Clips without sound get silence.
  - The frame size comes from the first video clip; other clips are letterboxed into it.
- **Render missing shots** goes through every shot in the cut that has no Final:
  - It switches to that shot, sets the ladder to step 4 and queues it. The stage capture happens at queue time, so each prompt carries its own shot. Ladder auto-rewind is paused during the batch.
  - Afterwards it restores the shot and step you were on.
  - When the last prompt finishes (`execution_success`/`execution_error`), it joins the cut by itself. A Draft-quality Final takes about 4–6 min per shot.
- **Renders persist per setup** in `node.properties.ss_renders` (`{setupId: {previz|look|draft|final|final_sound|final_audio: {filename, subfolder, type}}}`).
  - Before this they lived only in page memory and were lost on reload.
  - Each render is credited to the shot that was queued (`api.queuePrompt` is wrapped once to map prompt_id → setup), not to whichever shot happens to be active when it finishes.
- **Server:** `soundstage/cut/assemble.py`, route `POST /soundstage/cut/render_video` (registered in `__init__.py`). Tests: `tests/test_cut_assemble.py`.

## Every shot, every step

The guided steps work on every camera setup in the scene, not just the active one. ② Frame, ③ Motion, ④ Review and ⑤ Deliver each show a row of the scene's shots in cut order. Each card shows the shot's frame (or its clay) and where it stands: painting, frame chosen, draft only, final. Click a card to work on that shot.

- **② Frame → "…for every shot"** queues the same number of variations for each shot. A shot's first frame is its pick until you choose another. The pick (model + seed) and the Canvas touch-up flag are saved per shot on the node (`properties.ss_chosen`), so each shot's video starts from its own frame.
- **③ Motion → "Draft every shot" / "Final for every shot"** queues each shot that doesn't have one yet, in cut order. Before each one, the shot's own frame is applied to the still model and seed. Every queued prompt carries its own stage capture, and each render lands on its shot.
- **⑤ Deliver → "Layer Packs for every shot with a final"**.

Finals with sound are stored as `final_sound`/`final_audio`. `rendersFor()` also exposes them as `final`, so the Cut editor, the strip thumbnails and the Ladder play them.

## Edit from the timeline

Every clip in the Cut editor opens an **Edit in…** menu. Each item opens the step that made the clip, with that clip
loaded. **↩ Back to the cut** brings you back, and the new take comes in as a new version of the clip.

**Three ways in** (and the docked strip)
- Right-click a clip.
- The **✎** that shows at the top right of the clip under the pointer (clips at least 48 px wide).
- **E** (or Shift+F10, or the menu key): the selected clip, else the clip under the playhead. Arrows, Enter and Esc
  work in the menu.
- In the docked shot strip, a clip's right-click (or its … button) has **Edit in…**, which opens the same menu. That
  trip also comes back to the Cut editor: the hold and Replace are Cut edits (the strip's own Undo does not see them).

**What each item does, and when it is off.** An item that is off says why on its second line.

| Item | Final / Draft | Look still | Clay | Ripple, Pose, Performance or ✦ take | Imported footage |
| --- | --- | --- | --- | --- | --- |
| **First frame** (④ Frame) | the frame the take started from, outlined "From the cut" | this still | the shot's chosen frame, or "no frame yet" | Ripple: its edited frame 1; ✦: its source | on |
| **Re-generate** (⑤ Motion) | the take's preset, seed, Adherence and overrides | "Animate this frame": the shot's settings | "Render it": the shot's settings | runs again from the take's record (✦: the same card) | the shot's settings |
| **Re-block** (③ Set) | the shot camera at the clip's frame | on | on | on | on |
| **Ripple**, **Paint video-to-video** | on | off: a still has no motion | off: clay is drawn live | on (edit an edit) | off: not a ComfyUI file |
| **Recast camera** (✦ Reshoot) | on | off: Reshoot needs a clip | off | on | off |
| **✦ One-click cards…** | clip cards | still cards | off: nothing rendered | on | off |
| **Versions**, **Follow the latest render** | when the clip is pinned or has other takes | same | same | same | not shown |
| **Touch up its frame in Paint Studio**, **Compare in ⑥ Review** | on | on | on | on | on |

- **First frame never picks the frame for you.** "Use this frame" stays your click: choosing it changes the shot's
  frame, model, seed and Look file for every clip of that shot.
- **Re-generate** reads the take's settings from ComfyUI's own `prompt` tag in the file (the Quality node's `advanced`
  JSON: the preset, the seed, the Adherence). A take without a readable tag starts from the shot's current settings,
  and the step says so. The same seed gives the same take only with the same frame, Look and stage.
- **Re-block** shows the stage as it is now, not as it was when the take was rendered.
- **Ripple** needs the clip on Ripple's list: a clip pinned to an older take goes in through the import slot, which
  replaces the shot's one imported clip. Ripple starts at frame 0 of the clip.
- **Recast camera** opens ✦ Reshoot (it runs on Recast's engine); the App has no Recast panel. To recast a person, use
  Paint video-to-video.

**The hold.** Any jump first pins the clip, and every other clip of the same shot that follows the latest render, to
the take each plays now (clay stays clay; clips showing imported footage's camera original are not held). That is one
undoable edit. Nothing in the cut changes while you are away, even when new renders land.

**Back, Replace and Undo**
- While you are away, the step bar shows **↩ Back to the cut**; it turns yellow, "· new take", when a take of that shot
  lands (an App render, a Ripple / Pose / Performance / ✦ take, or a new frame for a Look or clay clip). Its ✕ ends the
  trip; the hold stays.
- Back switches to the trip's scene first (it waits while a render runs there), then opens the Cut with the same clip
  selected and the playhead where you left it.
- The Cut then offers the new take: **Replace in cut**, **Replace all N clips of this setup**, **Compare**, **Keep the
  old one**. Replace is off, with the numbers, when the take is shorter than the clip's out point.
- **Replace in cut** is one undoable edit: the clip plays the new take as its next version (`v3`), keeps its in and
  out points, transitions, opacity and notes, and lists the old take under its versions. The first ⌘Z brings the old
  take back (still held); a second ⌘Z undoes the hold, and the clip follows the newest render again.

**Versions and Follow the latest render.** The menu of a pinned clip lists its versions (`v1 · Final · 13:40`, the one
playing, the latest render when it is newer) and the shot's Ripple and ✦ takes: pick one to play it (one ⌘Z).
**Follow the latest render** unpins the clip: it plays its shot's newest render again and keeps the old take in its
versions.

**What the exports use.** Each clip's own take: the EDL gets one reel per file (a pinned file's reel carries its
version, e.g. `SC_3_WIDE_V1` with 32-character reels), FCPXML one asset per file, RELINK.txt one line per file, the AAF
one master per file (named with the version), OTIO and the Premiere XML each clip's own path. The server render and **Cut → one video** join the
pinned file.

**Still wrong (read first)**
- Pinning changes what the cut promises: a held clip stops following new renders until you Replace or Follow.
- The Cut viewer can only show a pinned take while that file is also its shot's current render, until the D8 player
  loads every file a clip plays. Exports, the strip, the server render and the AAF already use the pinned file.
- Re-generate is exact only when the take's `prompt` tag is readable. Ripple, Pose, Performance and ✦ takes re-run
  from their record (a shot keeps its last 40).
- A reload during a trip forgets the trip (the hold is saved in the cut; the menu still lists the newest render).
- There are two undo stacks: a hold or a Replace started from the strip is undone in the Cut editor, not in the strip.
- In and out points are clamped to the stage's length, not the take's; a take rendered at another rate lines up by
  time in the viewer, not in the EDL's source timecode.
- V3 graphic windows show the shot's latest render, not the clip's pinned take.
