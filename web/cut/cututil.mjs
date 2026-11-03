// D12 (Cut as an NLE) stub from S0a commit 1; owner: S0a. Design: nle_design_v1.md §3.1.
// Drawing and waveform helpers shared by cut.mjs and the D12 panes (moved out of cut.mjs by S0a commit 2).

export const RUNG_COLORS = { clay: "#5b6475", look: "#3d6ea8", draft: "#7652b3", final: "#3c9561" };
export const PEAK_BLOCK = 256;
export function sourceSize(_src) { return [0, 0]; }
export function drawContain(_ctx, _src, _x, _y, _w, _h) { return false; }
export function peaksOf(_buffer) { return new Float32Array(0); }
