# Activity: every job on the GPU queue

The **Activity** pill sits in the App's top row, just before **Guide**, and never folds into the "⋯" menu.
It reads `Idle`, or for example `2 running · 3 queued · ~6 min`. Click it for the Activity panel:

- **Running now**: the job in plain words (`Hollywood render · shot 1G · step 18/24`), a progress bar and %,
  time so far, about how long is left, and the live preview while it samples (when ComfyUI sends one).
- **Queued next**: place in line, what queued it (for jobs this page queued), and about when it starts.
- **Finished recently**: done / failed / cancelled, how long it took, links to its results, and failures in
  plain words ("Ran out of GPU memory…").
- **Cancel** on your own jobs only (a running job is interrupted, a queued one is taken off the queue).
  Other users' jobs on the shared queue are shown read-only, marked *another user*.

## Where the numbers come from

- ComfyUI's websocket events for what is running (`execution_start`, `progress`, `executed`,
  `execution_success`, `execution_error`, `execution_interrupted`, `b_preview`).
- `GET /soundstage/queue_summary` for order, labels and owners: every 4 s while anything is queued or the
  panel is open, every 20 s when idle, never while the tab is hidden. The App never fetches `GET /queue`
  or `GET /history` (they froze the pod on 2026-11-01).
- The App's own job registry. Any part of the App names a job it queued with

  ```js
  window.dispatchEvent(new CustomEvent("soundstage:job", { detail: {
    prompt_id, name: "Voice conversion · Jane", trigger: "Performance", width: 1280, height: 720 } }));
  ```

  A job nobody names keeps the server's label (`Final · Chase cam`, `Frame`, `Model call`).

## Time left

Each finished job adds its run time to a small rolling average per job kind and resolution (kept in this
browser's `localStorage` as `ss_activity_eta`). With a measured average, time left = average − elapsed;
before the first measured run of a kind, it is the current sampler's step rate (a lower bound for
multi-stage jobs). Queued starts add up everything ahead; when any job ahead has no estimate, the panel
says "at least", and the pill shows `≥`.

Code: [web/ui/activity.mjs](../web/ui/activity.mjs). Tests: [tests/js/activity.test.mjs](../tests/js/activity.test.mjs).
