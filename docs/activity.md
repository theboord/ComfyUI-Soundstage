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

## Time left

Each finished job adds its run time to a small rolling average per job kind and resolution (kept in this
browser's `localStorage` as `ss_activity_eta`). With a measured average, time left = average − elapsed. Before
the first measured run of a kind, or once a run passes its average, it is the running sampler's own step rate,
which counts only that sampler, so the panel says "at least" and the pill shows `≥`. Queued starts add up
everything ahead; when any job ahead has no estimate or only a lower bound, the panel says "at least".

The panel is rebuilt at most four times a second and never while a button in it is held, so Cancel works while
the sampler streams steps. Open Details and their scroll position survive the rebuilds.

Code: [web/ui/activity.mjs](../web/ui/activity.mjs). Tests: [tests/js/activity.test.mjs](../tests/js/activity.test.mjs).
Headless check: share/QA/activity_node_progress/ (simulated event stream on the try-it build).
