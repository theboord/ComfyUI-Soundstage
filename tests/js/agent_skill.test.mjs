// node --test tests/js/   (the Claude agent skill, skills/soundstage-agent/: valid frontmatter, its references exist and are
// the ones tools/build_knowledge.mjs generates; staleness itself is checked by knowledge.test.mjs via --check)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(ROOT, "skills", "soundstage-agent");
const skill = readFileSync(join(dir, "SKILL.md"), "utf8");

test("SKILL.md has the frontmatter a Claude skill needs", () => {
  const m = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "frontmatter block");
  const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1];
  const desc = (m[1].match(/^description:\s*(.+)$/m) || [])[1];
  assert.equal(name, "soundstage-agent", "name matches the folder");
  assert.ok(desc && desc.length > 60 && desc.length <= 1024, "a useful description under 1024 characters");
  assert.match(desc, /Soundstage/);
});

test("the skill's references exist and are linked from SKILL.md", () => {
  for (const f of ["references/lessons.md", "references/controls.md"]) {
    assert.ok(existsSync(join(dir, f)), f);
    assert.ok(skill.includes(f), `${f} is mentioned in SKILL.md`);
  }
  assert.match(readFileSync(join(dir, "references/lessons.md"), "utf8"), /Skill: The clay isn't locking into the final render/);
});

test("the rules the skill gives match the App's: GPU confirm, no Hollywood, never ComfyUI's Run", () => {
  assert.match(skill, /confirm_gpu: true/);
  assert.match(skill, /no Hollywood preset/i);
  assert.match(skill, /Never press ComfyUI's own Run button/);
});
