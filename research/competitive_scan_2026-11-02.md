# Competitive scan: #OpenSourceHiggsfield entries, 2026-11-02

Research only, for review by the lead session. Nothing here changes Soundstage.

## How this was done, and its limits

- **Sources.** GitHub repository search on the `open-source-higgsfield` topic and the phrases "OpenSourceHiggsfield" / "Open Source Higgsfield", limited to repos created after 2026-09-15 (about 110 hits). Web searches covered X, LinkedIn, YouTube and Reddit. Leads from those searches (Genobi on LinkedIn, Open Camera Studio on X, Freefield on YouTube) were then followed back to their GitHub repos.
- **Gaps.**
  - Reddit search found no entry threads. The only Reddit traction mentioned is CreatorOS's own README ("34k views on r/comfyui").
  - X search only returns profile and status pages, not a full hashtag timeline.
  - comfy.org is blocked by this session's network policy, so I could not read the official rules page. Third-party pages disagree on the deadline: Comfy's page is quoted as "November 3rd 9am PT", while older coverage says Oct 30. Winners are quoted as announced on 11/10 or Nov 6.
  - The curated list `jutsuhq/open-source-higgsfield` returned 404 when fetched (it may have been deleted or made private).
- **Licences.** For every entry below I downloaded and read the actual `LICENSE` file (raw from the default branch), not GitHub's label. Where a README says a subfolder carries a different licence, I fetched that file too.
- **Features.** Feature claims come from each project's README, not from running the code. Numbers such as "runs on 8 GB" or "37/42 hits within 1 frame" are the authors' claims.
- **Shortlist.** Out of about 110 repos I shortlisted the 42 closest to Soundstage: film studios, previs, camera, re-shoot, take QC, timeline/edit, VFX on plates, and the most-starred entries. Pure ad, meme and avatar tools were skipped.

## Headline findings

1. **Correction to "known so far": wexloops/openfield is MIT.** GitHub shows "Other"/NOASSERTION only because the LICENSE file has a note appended after the standard MIT text ("This license covers OpenField's own source code only… does not include… model weights"). That note narrows scope; it adds no restriction. Its code can be reused under MIT with its copyright notice (Copyright (c) 2026 David Wexler / Strangeloop Studios).
2. **Soundstage's biggest gap against the field is hardware reach, not features.** Our README recommends 48 GB of VRAM and calls 24 GB "untested". Competitors advertise:
   - 8 GB: Kinoloom
   - 12–16 GB: ReAngle, Backlot, Openjutsu, OpenReel
   - Apple Silicon: Toybox Director, Reshoot, Crew Cut
   - VRAM-tier weight swaps: CreatorOS, OpenField
3. **Most strong entries have a live way to try them without installing.** Examples: Hugging Face Spaces (Cue the Boom, Hero Frame Rig, Motion Guard), hosted apps (bulletcam.apsolut.dev, multicam.apsolut.dev, try.gobo.video, genobi.pages.dev) and mock backends. Our demo replays renders in a claude.ai artifact, which is good, but it cannot run a real job.
4. **Nobody else has Soundstage's depth.** No other entry combines screenplay → breakdown → 3D blocking with IK/mocap → physics/stunts → coverage → take QC → NLE exports → DCC round trip. The closest are:
   - CreatorOS-Studio: 3D blocking → LTX Layout-to-Render, clip QC with auto re-shoot, beat cut.
   - Motion Previs Studio: a 3D previs stage with auto-rigging and LTX/H3 render.
   - OpenField: a three.js greybox → LTX L2R, phone-to-mocap, reshoot.
   - Genobi: a three.js world, agent + editor, room acoustics.

   Our advantage is integration and film-craft rigour, so the ideas below are mostly about reach, verification and finishing.
5. **Recurring patterns in the field that we lack:**
   - an honest real-vs-simulated badge
   - a per-run cost estimate with a cap and a ledger (for cloud runs)
   - a "doctor"/pre-flight check of nodes and models
   - the exact ComfyUI workflow downloadable per take
   - jobs that re-attach after a server restart
   - install from the Comfy Registry / Manager

## Entries

Licence column: what the LICENSE file actually says. "(a)" means MIT, Apache-2.0 or BSD, so code is reusable with attribution. Apache-2.0 also requires carrying the NOTICE file if the repo has one, and marking changed files. "(b)" means copyleft or unclear, so idea only.

### Film studios and previs (closest to Soundstage)

| Entry | Licence (file) | Standout | What it does better than Soundstage |
|---|---|---|---|
| [wexloops/openfield](https://github.com/wexloops/openfield) | MIT + scope note (a) | three.js greybox → clay clip + exact depth pass → Z-Image look frame via depth ControlNet → LTX-2.5 Layout-to-Render. Phone-to-Mirror mocap by QR. Reshoot (CrossView-Warp + MoGe-2). Loop seam meter. ACEScg EXR / HLG finish. 31 MCP tools. | Checks a LoRA's tensor keys and only offers it for the base model it fits. HDR/ACES masters. Every take opens as its exact workflow. `npm run doctor`. A `CLAUDE.md` that turns install into an agent checklist. Render size chosen from VRAM. |
| [harlixay7/Kinoloom](https://github.com/harlixay7/Kinoloom) | MIT (a); README says `ComfyUI_LTX/comfy_extras/nodes_lt_audio.py` and an Impact-Pack file are GPL-3.0 | Claims LTX-2.5 22B + MiniMax H3 on an 8 GB RTX 3070 with 64 GB RAM. Long takes chained in latent space and decoded once, with a measured "pop" gate. GPU lease broker that evicts other models. Story-bible canon linter. | 8 GB reach. Seamless latent joins with numbers behind them. A thermal gate. The installer shows each model's licence before downloading. |
| [thePloggy/CreatorOS-Studio](https://github.com/thePloggy/CreatorOS-Studio) | Apache-2.0 (a) | Brief → LLM plans 3–6 shots → auto edit. 3D blocking → Qwen Edit → LTX L2R. Clip QC (black/frozen/jump/smear/face drift) that re-shoots once with a new seed. VRAM profiles 24/16/12/8 GB. Every render downloads as its API workflow. | Automatic re-shoot on any QC fail (we only offer one for Hollywood takes). VRAM-tier profiles. A setup wizard that estimates VRAM fit per feature. A live public demo (rate-limited). A content filter for public use. 48 stars, Reddit traction. |
| [navarisun1982/comfyui-motion-previs-studio](https://github.com/navarisun1982/comfyui-motion-previs-studio) | MIT (a) | Dual viewport (stage + viewfinder). Image-/text-to-3D GLB (TRELLIS.2/Pixal3D) with **automatic bone rigging** (humanoid, quadruped, flex spine, prop). Camera-frustum visibility engine writes "enters frame at 1.2 s" into the prompt. One-click render to H3/LTX. Side-by-side previs vs final player. | Auto-rigging of any generated GLB. Frame entry/exit timing in prompts (our `frame_lock` covers frame 1, not entries and exits over time). A synced side-by-side previs/final player. |
| [koshimazaki/genobi](https://github.com/koshimazaki/genobi) | MIT (a) | Three.js World Builder in ComfyUI → LTX L2R. **Acoustic Space**: set geometry and materials drive a CPU room-reverb estimate. Agent + human share one timeline. Camera wording adapted per model. Gallery of editable templates. | Room acoustics derived from the set (we have nothing like it). A hosted studio where templates are remixable and exportable as project ZIPs. A per-model camera-wording doc with sources. |
| [mahdi-salmanzade/toybox-director](https://github.com/mahdi-salmanzade/toybox-director) | MIT (a) | Toy props on a three.js stage. 3–8 keyframes each injected as an `LTXVAddGuide` guide frame. All keyframes restyled together as one side-by-side strip (Qwen-Image-Edit) so they stay consistent. | Multi-keyframe guides on cheap models. Restyling as a strip for consistency. Runs on Apple Silicon. |
| [martinsbrezauckis/OpenJutsu3D](https://github.com/martinsbrezauckis/OpenJutsu3D) | MIT (a) | LLM writes three.js "Scene Kit" code in a sandboxed iframe (one retry with the exact error). 33 chainable camera moves. Shots up to 60 s as crossfaded parts. Auto 48 fps for fast moves. Uses the Claude Code, Codex and Antigravity subscription CLIs as LLM backends. | Using subscription CLIs as the LLM. Shows cost per step. Poly Haven packs that keep their licences. Needs about 85 GB VRAM at 1080p, so heavier than us. |
| [IBFolding/haggs](https://github.com/IBFolding/haggs) | MIT (a) | Hosted Comfy Cloud studio with the price shown on every button. "Recreate an edit" from a reference video. **Sizzle doctor** scores a cut with ffmpeg only (pacing, loudness, dead air). Draw-to-video. An Academy of 7 lessons with a certificate. MCP with an Apply step. | Shows cost per action. Model-free cut scoring. Lessons as onboarding. |
| [RickBL99/gobo](https://github.com/RickBL99/gobo) | MIT or Apache-2.0, dual (a); example media/workflows CC BY 4.0 | One line → Autopilot film on Comfy Router. Rust/WASM shot compiler (byte-identical tests). **Steal the Look** (tone curve, palette, grain → nearest film stock). Film-stock 33³ LUT `.cube` export. Resolve-style colour page that reads LUTs/CDLs. CDL shot-matching. `flag` grade-continuity checker. Draw-the-move. | A real colour pipeline (CDL, grade match between takes, continuity across cuts). A BYOK public demo. A tour video recorded headlessly by `tools/make_tour.py`. |
| [Aitherium/aither-cinema-studio](https://github.com/Aitherium/aither-cinema-studio) | MIT (a) | Camera vocab compiled deterministically into prompts. **WebMCP**: 11 tools on `document.modelContext`, so an in-browser agent drives the UI. MCP schemas generated from `camera_vocab.json`. Beat-sheet music cut. | WebMCP. A GitHub Pages demo with a backend switch (local / remote / demo) using a Private Network Access preflight. One-line `curl \| sh` installers with sha256-checked downloads. |
| [MVOlekhno/previz2shot](https://github.com/MVOlekhno/previz2shot) | MIT (a) | Blender playblast → FLUX.2 Klein → LTX-2.5 L2R → back into the Blender VSE. | Nothing big. `COMFY_MIN_BALANCE_CENTS` refuses jobs below a credit floor. |
| [smithysw7/openreel](https://github.com/smithysw7/openreel) | MIT (a) | Logline → 8-shot short (H3 i2v + audio). Three-layer consistency (verbatim appearance text, head sheet, style lock). Backend auto-select local → cloud → mock. | Film made entirely on a 16 GB card. Zero-config mock mode. |
| [Arfolomew/backlot](https://github.com/Arfolomew/backlot) | MIT (a) | "Runs on a 16 GB card": exact ComfyUI flags with H3 text encoder on CPU. Latent chaining from the last latent (join drift 2.9/255 vs about 15% via PNG). Frees VRAM when the last browser tab closes. Async jobs re-attach on reload. | A documented 16 GB recipe with a timing table. Seamless latent extension. VRAM release. Job re-attach. |
| [Seif-Gits/Comfy-Studio](https://github.com/Seif-Gits/Comfy-Studio), [codyclack/opensfield](https://github.com/codyclack/opensfield) (MIT), [neuregex/freefield](https://github.com/neuregex/freefield) (MIT) | (a) | Broad Higgsfield-clone catalogues (Freefield claims 120 apps on open weights; Opensfield 146 tools including partner models). | Freefield's tooling: `tools/comfy_validate.py` (CPU validation in CI with empty model files), `tools/ui2api.py`, `tools/import_workflow.py`, VRAM measured per app, `tools/doctor.py`. Opensfield's honest `COVERAGE.md`. Comfy-Studio not read in depth. |

### Camera, re-shoot and lens

| Entry | Licence (file) | Standout | Better than Soundstage |
|---|---|---|---|
| [metababe-eth/hero-frame-rig](https://github.com/metababe-eth/hero-frame-rig) | App Apache-2.0; `ComfyUI-HeroFrameRig/` MIT (a) | **Rack focus / DOF after render** from Depth Anything 3 metric depth: tap start and end focus, round-disc bokeh in linear light. Beat Focus snaps to audio transients. Replayable recipe ZIP. | We pull focus at shoot time only, so a change of mind means a re-render. Free HF Space. |
| [LaytonGott/open-cinema](https://github.com/LaytonGott/open-cinema) | GPL-3.0 (b) | Change the lens after the shot: f/16→f/1.4 in about 7 s, click to focus, eased rack, anamorphic/vintage looks. | Same idea as Hero Frame Rig, plus anamorphic looks. Idea only. |
| [Tekholms-LW/ReAngle](https://github.com/Tekholms-LW/ReAngle) | Apache-2.0 (a) | Draw a new camera path in a depth mesh of the clip (±30° envelope) → z-buffered warp → LTX L2R. Chunked long clips with LAB colour match and drift metrics. Tiers from 12 to 80 GB. `nvidia-smi` watchdog. | Low-VRAM tiers. Watchdog. Per-chunk drift metrics. README warns Video Depth Anything Base/Large are CC-BY-NC. |
| [kristopolous/dollygrip](https://github.com/kristopolous/dollygrip) | Apache-2.0 (a) | One-line shot DSL (`then`, `+`, easings) → deterministic trajectory → CPU ray-cast guide → LTX + Cameraman IC-LoRA (the LoRA is non-commercial). Share codes `dg1-…`. | Shareable text DSL and share codes. `scripts/resolve_workflow.py` auto-installs the nodes and models any workflow needs. |
| [apsolut/bullet-time-comfyui](https://github.com/apsolut/bullet-time-comfyui) | MIT (a) | Freeze-time orbit on real footage: moment picker (motion × sharpness, eyes-open check), 8 Qwen views as LTX guide keyframes, slow-mo/rewind splice. `--dry-run` cost estimate and a paid-job ledger. | Bullet time. A cost ledger. A hosted app. |
| [apsolut/one-shot-multicam](https://github.com/apsolut/one-shot-multicam) | MIT (a) | One selfie take → CAM B/C via the CrossView IC-LoRA, with real audio frozen into the audio latent. Cuts on Whisper word boundaries. Shot/reverse with "your other self". Dub mode (translation + LipDub IC-LoRA). | Lip-synced dubbing. Continuity rules ("no wide over speech", in `multicam/continuity.py`). A mouth-motion check per insert (`multicam/lipcheck.py`). |
| [pyoonpyoon/open-higgsfield](https://github.com/pyoonpyoon/open-higgsfield) | MIT (a) | 96-pose angle globe (Multiple-Angles LoRA). "12 best angles" coverage in one click. Official LTX-2 camera LoRAs. Dry-run downloads the exact workflow. | `validate-workflows.mjs` checks graphs against `/object_info`. GGUF path for Apple Silicon. Vercel demo. |
| [BurtTheAI/open-camera-studio](https://github.com/BurtTheAI/open-camera-studio) | MIT (a) | Camera moves from one still: hand-built 2.5D depth layers point-splatted into a guide, then Wan 2.2 refine. | Nothing notable; its README is upfront that the demo is simulated. |
| [kevin9327/OpenSourceHiggsfield](https://github.com/kevin9327/OpenSourceHiggsfield) | MIT (a) | Camera-rig, depth-reshoot and relight nodes. Umeyama Sim(3) camera-trajectory verifier. | Sim(3) trajectory check, a stricter camera-follow metric. README is marketing-heavy; quality unknown. |
| [ksamplermagazine/shotfix](https://github.com/ksamplermagazine/shotfix), [bolttmade/shot-director](https://github.com/bolttmade/shot-director) | Apache-2.0 / MIT (a) | Simple 3D-guided reshoot (closed APIs) / simulated previs then one paid render. | Shot Director: a green "real" vs amber "simulated" badge, `MAX_CREDITS_PER_RUN`, and a `recipe.json` beside every output. |

### Take QC, plates and VFX

| Entry | Licence (file) | Standout | Better than Soundstage |
|---|---|---|---|
| [junco3/motion-guard](https://github.com/junco3/motion-guard) | **Apache-2.0** (a) (the LICENSE file is Apache, so ignore any "MIT" summary). Has a NOTICE, which must be carried. | Compares an LTX stage-1 clip with the 3D motion reference *before* the costly stage 2: PCK after a clip-wide time shift, a per-joint WRONG_POSE check over ±0.25 s, missing-motion windows judged against estimator noise, fingertip checks with RTMW hands. Repairs single-latent spikes. | Much more rigorous than our single "follows your blocking" score. It gates the expensive pass, which saves Hollywood time. HF Space. |
| [TusharTechs/platelock](https://github.com/TusharTechs/platelock) | MIT (a), including `comfyui-platelock/` | Composites generative VFX back onto the plate so untouched pixels stay bit-identical. Difference matte (robust tone fit, hysteresis in space and time), temporal stabilise, re-grain, **Fidelity Report** (% bit-identical and PSNR outside the effect). | Proves the plate is untouched. Our ✦ relight/weather and Recast re-render whole frames. |
| [AInVFX/ainvfx-paintaplate](https://github.com/AInVFX/ainvfx-paintaplate) | Apache-2.0 (a) | Paint on frame 1 to erase/add/relight, and the edit carries through the shot. Plate-exact export (EXR, bit depth, timecode, colour tags). OCIO viewer in the OpenRV style. Its own trained IC-LoRA with weights and dataset published. On the Comfy Registry; CI runs a real ComfyUI on CPU. | OCIO-correct review and plate-exact delivery (we match source spec but have no OCIO viewer). Registry distribution. |
| [lucataco/open-source-higgsfield](https://github.com/lucataco/open-source-higgsfield) (Body Double) | Apache-2.0 (a) | Recast with a follow-cam crop that keeps a small performer large, then pastes only the performer back into the full-res plate. SAM 3.1 re-ID after occlusion. 81-frame segments with per-segment QC that re-rolls one bad segment. | Plate-preserving paste-back and segment-level re-roll for our Recast. |
| [D3voz/openjutsu](https://github.com/D3voz/openjutsu) | MIT (a) | The most-starred entry (≈1.2k). Swaps 1–4 roles with Qwen3-VL matching tracks to roles, scrubbable "Check mask" preview, face-fix crop/redraw/paste, pre-flight against `/object_info` with install links. | Mask preview before a long render. Face repair rather than only face-drift detection. README warns face-fix uses InsightFace (non-commercial) and AGPL Ultralytics weights. |
| [grzenio22/cue-the-boom](https://github.com/grzenio22/cue-the-boom) | MIT; `cuesync/` Apache-2.0 (a); workflows under the LTX-2 Community Licence | Generate an effect once, then retime it to your voice/hand on CPU. CueSync measures effect onset (claimed 37 of 42 hits within 1 frame). | HF Space with no GPU. A "Judging it?" quick path for judges. |
| [Burgstall-labs/ComfyUI-SpEdE](https://github.com/Burgstall-labs/ComfyUI-SpEdE) | **AGPL-3.0** (b) | Gaussian-splat object remove/replace with named fail-closed gates. | We import splats but cannot edit them. Idea only. |

### Edit, timeline and agents

| Entry | Licence (file) | Standout | Better than Soundstage |
|---|---|---|---|
| [jdnichollsc/seam](https://github.com/jdnichollsc/seam) | MIT (a) | **Generative transitions** (smoke, water bend, whip pan; 10 effects each reviewed on 2 pairs × 2 seeds) with LTX-2.5 first/last frame. Slot-mapped API graphs + `workflows/slots.json`. Jobs persist in SQLite. Ships as a Claude Code plugin. | Our Cut has dissolves, dips and wipes only. Jobs survive a restart. |
| [doubletwisted/ComfyUI-Spool](https://github.com/doubletwisted/ComfyUI-Spool) | GPL-3.0 (b) | Timeline where each clip is a take from *your own unmodified workflow*. "Edit in Comfy" / "Apply to clip". Renders on Comfy Cloud or a **Deadline farm**. | Wraps arbitrary workflows. Farm rendering. Idea only. |
| [chenthedesignmaker/ComfyUI-Picky](https://github.com/chenthedesignmaker/ComfyUI-Picky) | GPL-3.0 (b) | H3-aware **prompt linter**, and the AI writer repairs its draft against it. `@Mara` mentions become `<Subject N>`. Prompt-version lineage with takes attached. | Model-specific prompt linting. Prompt version history tied to takes. Idea only. |
| [rk0neki/OpenKatana](https://github.com/rk0neki/OpenKatana) | Apache-2.0 (a) | 72 CLI/MCP tools, 85 nodes, 6 ComfyUI **App-mode** entry points. On the Comfy Registry (`comfy node install openkatana`). | Registry distribution. Richer kinetic typography. A copy-paste agent setup prompt. |
| [0xMisterBailey/Boson](https://github.com/0xMisterBailey/Boson) | MIT (a) | Taste as files in git (`TASTE.json`, `LOOP.jsonl`): every judgement is a commit and you can branch from any round. Nodes run `stored` or `live`, so shipped work replays with no key. | Taste that builds up across rounds. Offline replay. |
| [MajoorWaldi/HyperKut-Studio](https://github.com/MajoorWaldi/HyperKut-Studio) | MIT (a) | "Best of two takes": a local VLM picks the better generation. Lyrics transcribed and placed as kinetic text. | Auto-selecting the circled take. |
| [slit-company/viral-hit](https://github.com/slit-company/viral-hit) | Apache-2.0 (a) | Reference → storyboard split at cuts → remake → multitrack → publish → metrics. Idempotent paid-job ledger. UI in four languages. | Publishing and i18n (mostly closed APIs). |
| [Alvinvision/360-Scout-to-Film-Consistency](https://github.com/Alvinvision/360-Scout-to-Film-Consistency) | MIT (a); demo media excluded (`MEDIA_NOTICE.txt`) | 2:1 panorama → 5 overlapping perspective location refs + contact sheet + JSON manifest (`custom_nodes/comfyui_osmo360`, CPU only). | Location consistency from a real 360 capture. |
| [GiveMePrompts/crew-cut](https://github.com/GiveMePrompts/crew-cut) | MIT (a) | A party game: phones join by QR, players direct scenes, the TV premieres the film. Runs on an M2 Max. | Social/viral hook. |

GitHub-labelled entries I did not inspect in depth: `mojomast/open-higgsfield-skills` and `Orazen/conjure` (NOASSERTION), `audriu/fxjutsu` and `kingofmit/ComfyUI-HiggsOpen` (no licence file). Without reading a LICENSE, treat them as (b).

## Top 10 ideas worth adding to Soundstage (ranked)

The ranking weighs judge impact before tomorrow's 9 AM PST resubmission, how much it widens who can run Soundstage, and how well it fits what we already have. "(a)" = code reusable under its licence with attribution. "(b)" = idea only, build our own.

1. **Low-VRAM profiles (16 and 24 GB, ideally 12 GB).** Add a VRAM-tier switch that swaps in GGUF/INT8 weights, moves the text encoder to CPU, frees models between steps, and adds a setup check that says which features fit your card. This is the single widest gap: every serious rival claims 8–16 GB while we say 48 GB recommended and 24 GB untested.
   - Sources: Backlot (its documented 16 GB flags), Kinoloom (GPU lease broker `tool/gpu_broker.py`), CreatorOS (VRAM profiles + fit wizard), ReAngle (tiers + `nvidia-smi` watchdog).
   - Marking: **(a)** for Backlot's `app/comfy_backend.py` and Kinoloom's `tool/gpu_broker.py` (both MIT; do not take Kinoloom's two GPL files). The tier logic itself is quick to write as our own.

2. **A per-joint motion gate before the Hollywood pass.** Extend "follows your blocking" into a gate on the stage-1 draft: PCK after a time-shift search, per-joint wrong-pose windows, missing-motion windows judged against estimator noise, and fingertip checks. On a FAIL, hold or re-roll before spending the 2624×1408 pass. It fits our QC story and saves the most GPU time.
   - Source: junco3/motion-guard (Guard/StageGate node, `tools/reanalyse_sample.py`).
   - Marking: **(a)** Apache-2.0. Carry its NOTICE, mark changed files, credit in THIRD_PARTY_NOTICES.

3. **Rack focus and depth of field after the render.** Add a ✦ card "Refocus" on any take: tap two focus points, choose a T-stop, and depth from Depth Anything 3 drives a disc-bokeh blur in linear light. Beat-snapped focus is a bonus. It matches our real-lens story (focus pulls already exist at shoot time) and needs no re-render.
   - Source: metababe-eth/hero-frame-rig, `ComfyUI-HeroFrameRig/` (numpy/torch only).
   - Marking: **(a)** MIT. Open Cinema does the same but is GPL, so do not use its code.

4. **Proof that the plate is untouched, for ✦ edits and Recast.** Composite ✦ relight/weather and Recast results back onto the source plate through a difference matte. Report "% bit-identical / PSNR outside the edit" as a take chip. It fits our "delivered at source spec" story.
   - Sources: TusharTechs/platelock `comfyui-platelock/` (pure-PyTorch nodes, unit-tested). Body Double's follow-cam crop + paste-back for small performers.
   - Marking: **(a)** MIT (PlateLock) and Apache-2.0 (Body Double `bodydouble/`).

5. **Generative transitions in the Cut.** Add "Smoke / Water bend / Whip pan / Match cut…" between two clips via LTX-2.5 first/last frame, rendered into the timeline like our sound-in-place. Rivals already have it, and it demos well in a 2-minute video.
   - Source: jdnichollsc/seam (slot-mapped graphs in `src/seam/workflows/` + `workflows/slots.json`, effect presets).
   - Marking: **(a)** MIT.

6. **A try-it-live path, with an honest real-vs-simulated badge.** Our artifact demo replays real renders. Add:
   - an explicit "Replayed / Live" badge
   - a Comfy Cloud bring-your-own-key mode that runs one real Draft shot
   - a judge's quick path in the README ("Judging it? Start here")
   - a `doctor` that pre-flights nodes and models against `/object_info` with install links

   The contest is on the Comfy Developer Platform, and judges reward trying the app live.
   - Sources: Cue the Boom, Hero Frame Rig, Aither, Shot Director, Openjutsu, Freefield.
   - Marking: **(a)** for Freefield's `tools/comfy_validate.py` (empty model files so ComfyUI validates on CPU in CI) and `tools/doctor.py`, both MIT; the rest is our own.

7. **Seamless long takes via latent chaining.** Extend a take past one LTX window by continuing from the last latent, not the last PNG. Gate each join with a measured "pop" ratio and fail it above a threshold. This gives continuous oners for stunts and chases.
   - Sources: Kinoloom (pop gate and figures, `tool/continuity.py`), Backlot (latent chaining from the last latent, join drift 2.9/255).
   - Marking: **(a)** MIT, avoiding Kinoloom's GPL `nodes_lt_audio.py` and Impact-Pack file. The LTX audio side must be our own code.

8. **A colour pipeline: grade match, Steal the Look, `.cube`/CDL out.** Add:
   - per-take CDL with automatic shot matching across coverage
   - a grade-continuity check across cuts in the Coach
   - "Steal the look" from a reference frame to the nearest film stock in our Look tab
   - `.cube` LUT export in the NLE package

   It fits our editorial / DCC deliverables.
   - Source: RickBL99/gobo crates `scrim` (grading) and `flag` (continuity).
   - Marking: **(a)** MIT/Apache dual (pick MIT). The crates are Rust/WASM, so porting the maths to Python/JS may be simpler than vendoring. Credit either way.

9. **Auto-rig any generated or imported GLB, and track who is in frame over time.** Photo → 3D and Import world give us meshes but not new rigged characters. Add:
   - an auto-rig for humanoid, quadruped, flex-spine and prop meshes, so any TRELLIS/Hunyuan character can be posed and mocapped
   - frame entry/exit times sampled from the camera frustum across the shot ("the rider enters frame left at 1.2 s") added to the LTX prompt; today `frame_lock` covers frame 1 only
   - Source: navarisun1982/comfyui-motion-previs-studio (`autoRigEngine.ts`, `povVisibilityEngine.ts`).
   - Marking: **(a)** MIT.

10. **Distribution and one-click install.** Publish to the Comfy Registry (`comfy node install`), ship a `doctor`/`install.sh` that downloads models with sha256 checks and is resumable, and offer a `CLAUDE.md`-style agent install checklist. Our README install is nine manual lines plus a manual 60 GB model download; rivals are one command.
    - Sources: OpenKatana and Paint-a-plate (Registry), Aither (one-line installers), OpenField (agent install checklist), DollyGrip (`scripts/resolve_workflow.py` auto-installs whatever a workflow needs).
    - Marking: **(b)** for the packaging work; DollyGrip's resolver is **(a)** Apache-2.0 if we want it.

### Honourable mentions (smaller or later)

- **Room acoustics from the set.** Reverb estimated from set geometry and materials, fed into our A1–A4 mix. Genobi, **(b)** (MIT, but its README names no small liftable piece; build our own).
- **Per-run cost estimate, cap and ledger.** Only once a Comfy Cloud mode exists. Bullet-time and Shot Director, **(a)** MIT.
- **360 panorama → location reference sheet** for ② Cast & Locations. 360 Scout `comfyui_osmo360`, **(a)** MIT.
- **Model-specific prompt linter** that checks our compiled LTX prompt and auto-repairs it. Picky, **(b)** GPL.
- **Auto-pick the circled take with a VLM** (we already judge; this would select). HyperKut, **(b)** (no file named).
- **Lip-synced dub to other languages** and the "no wide over speech" continuity rule. One-shot Multicam `continuity.py` / `lipcheck.py`, **(a)** MIT.
- **WebMCP** (`document.modelContext`) next to our MCP server. Aither, **(b)**.
- **LoRA ↔ base-model compatibility check by tensor keys** for the model router. OpenField, **(a)** MIT (`server/graphs/*.ts` area; locate the exact file before lifting).
- **Jobs re-attach after a server restart.** Seam, Backlot, Toybox, **(b)**.

## Attribution checklist for anything lifted

- **MIT:** keep the original copyright line and the permission notice in the copied file or a sibling LICENSE file. Add a row to `THIRD_PARTY_NOTICES.md` (component, where, licence, link). Credit it in the README "Credits" section, as the contest asks.
- **Apache-2.0:** as above, plus include their NOTICE file content if one exists (motion-guard has one; Body Double has one), and state in changed files that they were modified.
- **Dual MIT/Apache (Gobo):** choose MIT and say so in the notice row.
- **Never copy from:** Spool, Picky and Open Cinema (GPL-3.0); SpEdE (AGPL-3.0); Kinoloom's two GPL files; any repo without a LICENSE file.
- **Model weights are separate:**
  - Cameraman IC-LoRA (DollyGrip) is non-commercial.
  - Video Depth Anything Base/Large are CC-BY-NC.
  - InsightFace buffalo_l is non-commercial.
  - Ultralytics weights are AGPL.

  Check each against MODELS.md and our router's licence badges before wiring.

## Sources

- GitHub topic: https://github.com/topics/open-source-higgsfield
- Every repository linked in the tables above (LICENSE and README read 2026-11-02)
- Comfy's announcement on X (cease-and-desist reply, dates): https://x.com/ComfyUI/status/2115928993623109648
- OPENjutsu announcement: https://x.com/ComfyUI/status/2114843030364795231
- Entry post by B. Elliott Baker: https://x.com/spiritform/status/2115674848630591970
- Freefield demo on YouTube: https://www.youtube.com/watch?v=N7mv2v3Txeo
- Contest coverage: https://comfyui-wiki.com/en/news/2026-10-15-open-source-higgsfield and https://artrealmai.com/article/comfy-open-source-higgsfield-25k-challenge
- Willie Falloon's LinkedIn entry post naming "Genobi": https://www.linkedin.com/in/willie-falloon-961a8a68/ (the Genobi repo found on GitHub is by koshimazaki; I could not confirm the two are the same project or person)
- Cue the Boom contest release: https://github.com/grzenio22/cue-the-boom/releases/tag/contest-2026-10-30
