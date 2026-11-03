// The playback bench's frame attribution (tools/qa/playback_bench.mjs ticksOf): a pooled <video> re-pointed at another
// take must count its frames for the take it plays at that draw, not the first one it ever loaded.
import test from "node:test";
import assert from "node:assert/strict";
import { ticksOf, takeOf } from "../../tools/qa/playback_bench.mjs";

test("a drawn frame belongs to the take the element plays at that draw (pooled elements are reused)", () => {
  const raw = { vids: [{ id: 0, url: "/api/view?filename=A.mp4&type=output" }], ticks: [
    [0, 1, 0, 10, 1, ["v", 0, 10 / 24 * 1e6, 10 / 24, 4, null, null, "/api/view?filename=A.mp4&type=output"], null, "play"],
    [17, 1, 0, 11, 1, ["v", 0, 3 / 24 * 1e6, 3 / 24, 4, null, null, "/api/view?filename=B.mp4&type=output"], null, "play"],
    [34, 1, 0, 12, 1, ["v", 0, 4 / 24 * 1e6, 4 / 24, 4, null, null, null], null, "play"],   // a run recorded before the field
  ] };
  assert.deepEqual(ticksOf(raw, 24).map((t) => t.draw.key), ["/api/view?filename=A.mp4&type=output", "/api/view?filename=B.mp4&type=output", "/api/view?filename=A.mp4&type=output"]);
  assert.equal(takeOf("/api/soundstage/proxy?filename=B.mp4&type=output&w=960"), "/api/view?filename=B.mp4&type=output", "a proxy counts as its take");
});
