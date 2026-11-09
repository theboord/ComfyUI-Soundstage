# Activity: every job on the GPU queue, and which node yours is on

The **Activity** pill sits in the App's top row, left of **Book** and **✦ Ask**, and never folds into the "⋯" menu.
It reads `Idle`; while one of your jobs runs it leads with the step that job is on, for example
`Sampling: stage 1 · 8/12 · 2 queued · ~6 min`, with a thin progress bar along its bottom edge. Click it for the panel:

- **Running now**: the job in plain words (`Final · shot 1G`); for your own job, the stage it is on
  (`Sampling: stage 1`, `Upscaling ×2: stage 2`, `Depth map`, `Pose (DWPose)`, `Decoding video (VAE)`,
  `Encoding prompt (Gemma)`, `Loading model`, `Saving MP4`), the sampler's steps (`step 8/12`) with an inner bar,
  `node 7 of 11 · 2 cached`, time so far, about how long is left, and the live preview while it samples.
  **Details** lists every node as it ran with its time; cached nodes are folded into one line. **Node types
  (class and id)** shows `KSampler #12` instead of the plain names (kept in this browser as `ss_activity_raw`).
- **Queued next**: place in line, what queued it (for jobs this page queued), and about when it starts.
- **Finished recently**: done / failed / cancelled, how long it took, links to its results. A failure names the
  node (`Failed at Decoding video (VAE) (VAEDecodeTiled #16)`), the plain words (`Ran out of GPU memory…`) and
  ComfyUI's own first line. An interrupted job says where it stopped (`Cancelled at Depth map`).
- **Cancel** on your own jobs only (a running job is interrupted, a queued one is taken off the queue).
  Jobs from other browsers or people are shown read-only, marked *another session*, without node detail.

## Stage names

[web/ui/activity.mjs](../web/ui/activity.mjs) `STAGES` maps a node's class_type to a stage name; the first match
wins and anything else shows its class_type. A node title someone set (not the class_type and not the node's
default display name) replaces the stage name. Samplers and latent upscalers are numbered when a prompt has more
than one sampling stage: a sampler after a sampler, or an upscaler after a sampler, starts the next stage. The
upscale factor comes from the upscaler's inputs or the model file it loads (`…-x2-…` -> `×2`).

## Where the numbers come from

- ComfyUI's websocket events (`execution_start`, `execution_cached`, `executing`, `progress`, `progress_state`,
  `executed`, `execution_success`, `execution_error`, `execution_interrupted`, `status`, `b_preview`). In the
  ComfyUI frontend `executing`'s detail is the bare node id (it belongs to the prompt that is running) and
  `status`'s is `{exec_info: {queue_remaining}}`. ComfyUI sends node events only to the session that queued the job.
- The prompt this page POSTs to `/prompt`, seen once in `api.fetchApi` at queue time: node id -> class_type and
  title. No payload is kept.
- `GET /soundstage/queue_summary` for order, labels and owners: every 4 s while anything is queued or the
  panel is open, every 20 s when idle, never while the tab is hidden. One registry and one poll per page, however
  many Stage nodes are on the graph. A job of yours that leaves the queue without an event is looked up by its own
  `GET /history/{prompt_id}` (its status messages replay, so a missed error still names its node). The App never
  fetches the full `GET /queue` or `GET /history` (they froze the pod on 2026-11-01).
- The App's own job registry. Any part of the App names a job it queued with

  ```js
  window.dispatchEvent(new CustomEvent("soundstage:job", { detail: {
    prompt_id, name: "Voice conversion · Jane", trigger: "Performance", width: 1280, height: 720 } }));
  ```

  A job nobody names keeps the server's label (`Final · Chase cam`, `Frame`, `Model call`).

## The countdown at the top

While any render runs (a ④ Frame still, a Draft, a Final, Recast, Video → 3D…), a band above the App's top bar shows,
big enough to read from across the room: the job and shot (`Draft · shot 3`, and the stage it is on), **ELAPSED**
(how long it has run) and **TIME LEFT** (how much longer), with how sure that is: `about ±0:40` (three or more runs of
this job on this machine), `±1:10 · from 2 runs`, or `rough first guess · ±2:30` (none yet: the numbers in these docs,
scaled to the job's size). With nothing to go on it says **Learning how long this takes**; past its estimate it adds
`longer than usual +0:30`. Under them: a progress bar (ComfyUI's node-by-node progress), `2 more after this · all
done in about 7:30`, **Stop** (your own job: the same stop as Cancel), **Chime on/off** (the finish chime),
**A− / A+** (big or small) and **–** (collapse to a pill; click the pill to open it again). Big/small and collapsed
are kept per viewer in this browser (`ss_countdown_prefs`). When the job ends: `Done: Draft of shot 3 (2:41)` for a
few seconds, or **Failed** with the plain reason and **Why it failed** (opens this panel), then it hides. It is in
the page flow, never over the stage or the shot monitor, and it shows in every view; at phone width the clocks sit
side by side under the job's name. It has no clock of its own: it ticks only while a job runs.

**The estimate.** Each finished job of yours teaches a small book kept per machine (the GPU's name), model, job kind
and resolution (`ss_estimator_v1` in this browser): seconds per sampler step for each stage (stage 1, stage 2), per
megapixel × frame × generation; the model load, cold (the loaders ran) and warm (ComfyUI had them cached); the VAE
decode; and the rest. Before a job starts its estimate is load + each stage's steps × its time per step + decode +
the rest, from the queued graph's own step counts, size, frames and batch (4 variations is about 4× the sampling).
While it runs, the time per step measured in this run replaces the book's and scales the stages still to come, so
the countdown settles as the job goes.

## Time left

For a job the estimator can't size (another session's, or one whose graph this page didn't see), each finished
job adds its run time to a small rolling average per job kind and resolution (kept in this
browser's `localStorage` as `ss_activity_eta`). With a measured average, time left = average − elapsed. Before
the first measured run of a kind, or once a run passes its average, it is the running sampler's own step rate,
which counts only that sampler, so the panel says "at least" and the pill shows `≥`. Queued starts add up
everything ahead; when any job ahead has no estimate or only a lower bound, the panel says "at least".

The panel is rebuilt at most four times a second and never while a button in it is held, so Cancel works while
the sampler streams steps. Open Details and their scroll position survive the rebuilds.

Code: [web/ui/activity.mjs](../web/ui/activity.mjs), [web/ui/countdown.mjs](../web/ui/countdown.mjs),
[web/ui/estimator.mjs](../web/ui/estimator.mjs). Tests: [tests/js/activity.test.mjs](../tests/js/activity.test.mjs),
[tests/js/countdown.test.mjs](../tests/js/countdown.test.mjs), [tests/js/estimator.test.mjs](../tests/js/estimator.test.mjs).
Headless check: share/QA/activity_node_progress/ (simulated event stream on the try-it build).
