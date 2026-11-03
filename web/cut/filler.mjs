// D12 (Cut as an NLE) stub from S0a commit 1; owner: P1b. Design: nle_design_v1.md §6b.
// Filler (a reserved shot id, like Avid's filler clip). Pure.

export const FILLER_ID = "__filler__";
export const isFiller = (e) => !!e && e.shot_id === FILLER_ID;
export function fillerShot(_project) { return { id: FILLER_ID, name: "Filler" }; }
export function normalizeFillerFields(project) { return project; }
