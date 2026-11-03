// D12 (Cut as an NLE) stub from S0a commit 1; owner: S0a. Design: nle_design_v1.md §3.1, 4.2.
// The NLE fields of the project. Imports nothing from timeline.mjs (no import cycle).

import { normalizeFillerFields } from "./filler.mjs";
import { normalizeMixFields } from "./mixmodel.mjs";
import { normalizeTrimFields } from "./trimmodel.mjs";

/** The NLE's own project fields, saved only when set (cut.mjs savedFields). */
export const NLE_FIELDS = ["markers", "lanes", "mix"];

/** Fields one edit snapshots, commits and re-reads from the host. B's rate keys join when B lands (nle_design 3.4). */
export const EDIT_FIELDS = ["titles", "subtitles", "fade_out", "burn_subtitles", "graphics", ...NLE_FIELDS];

/** Runs the three piece normalizers. Each returns the project unchanged until its owner fills it. */
export function normalizeNle(project) {
  return normalizeTrimFields(normalizeMixFields(normalizeFillerFields(project)));
}

/** Extra audio_tracks[] keys (gain_db, pan, target, sync_lock), written only when not default. */
export function trackExtras(_t) { return {}; }
