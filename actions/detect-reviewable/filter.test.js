// Tests for the filter that decides whether a pull request is reviewed at all.
// Nothing executed it before: the "Composite actions parse" job reads
// action.yml and stops, so a wrong path pattern here silently skipped review
// on every fleet repository at once. That is exactly how `.agents/` went
// unreviewed -- it matched neither pass, and because its files all end `.md`,
// pass 2 discarded them (crossroads-ui CR-R-022). Run with:
//
//   node --test actions/detect-reviewable/filter.test.js
//
// CommonJS and node:test only, matching actions/gate/check.test.js: these
// tests must need nothing but the node binary every runner already carries.
//
// The script under test is extracted from action.yml rather than copied, so a
// change to the action is a change to what these assertions cover. Only the
// `gh api` line is replaced -- with the fixture file list -- because the rest
// of the pipeline IS the thing being tested.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ACTION = path.join(__dirname, "action.yml");

function filterScript() {
  const yaml = fs.readFileSync(ACTION, "utf8");
  const marker = "      run: |\n";
  const start = yaml.indexOf(marker);
  assert.notStrictEqual(start, -1, "action.yml has no `run: |` block");

  const body = yaml
    .slice(start + marker.length)
    .split("\n")
    // The block ends at the first line that is neither blank nor indented
    // past the YAML scalar's own indent.
    .reduce((lines, line) => {
      if (lines.done) return lines;
      if (line.trim() !== "" && !line.startsWith("        ")) {
        lines.done = true;
        return lines;
      }
      lines.push(line.slice(8));
      return lines;
    }, Object.assign([], { done: false }))
    .join("\n");

  // Replace only the API call. Everything downstream runs as written.
  const stubbed = body.replace(
    /^files="\$\(gh api .*\)"$/m,
    'files="$FIXTURE_FILES"'
  );
  assert.notStrictEqual(stubbed, body, "the gh api line was not found to stub");
  return stubbed;
}

function detect(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-reviewable-"));
  const out = path.join(dir, "output");
  const summary = path.join(dir, "summary");
  fs.writeFileSync(out, "");
  fs.writeFileSync(summary, "");

  const result = spawnSync("bash", ["-c", filterScript()], {
    env: {
      PATH: process.env.PATH,
      FIXTURE_FILES: files.join("\n"),
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: summary,
    },
    encoding: "utf8",
  });

  assert.strictEqual(result.status, 0, `filter exited ${result.status}: ${result.stderr}`);
  const written = fs.readFileSync(out, "utf8");
  fs.rmSync(dir, { recursive: true, force: true });

  const match = written.match(/^reviewable=(true|false)$/m);
  assert.ok(match, `no reviewable output, got: ${JSON.stringify(written)}`);
  return match[1] === "true";
}

test("a contract tree is reviewable even though its files are Markdown", () => {
  // The regression this file exists for. Each of these is Markdown, so pass 2
  // discards it; only pass 1 can rescue it.
  for (const tree of [".github", ".claude", ".agents"]) {
    assert.strictEqual(
      detect([`${tree}/skills/crossroads-typography/SKILL.md`]),
      true,
      `${tree}/ must be reviewable`
    );
  }
});

test("the same edit is judged the same in .claude/ and .agents/", () => {
  // These two trees carry byte-identical skills in crossroads-ui. A filter
  // that reviews one and not the other lets an author pick the unreviewed
  // copy, which inverts the whole point of always-reviewing contract trees.
  const file = "skills/crossroads-motion/SKILL.md";
  assert.strictEqual(detect([`.claude/${file}`]), detect([`.agents/${file}`]));
});

test("documentation outside the contract trees is still not reviewable", () => {
  assert.strictEqual(detect(["docs/DEFECT_LOG.md"]), false);
  assert.strictEqual(detect(["README.md"]), false);
  assert.strictEqual(detect(["docs/a.md", "README.md"]), false);
});

test("code is reviewable, and one code file carries a docs-only batch", () => {
  assert.strictEqual(detect(["src/components/Button.tsx"]), true);
  assert.strictEqual(detect(["docs/a.md", "src/index.ts"]), true);
});

test("an empty file list is not reviewable", () => {
  assert.strictEqual(detect([]), false);
});

test("both passes name the same trees", () => {
  // Pass 1 selects the contract trees and pass 2 subtracts them. If the two
  // alternations drift apart, a tree is either counted twice or falls through
  // both -- the second is how this defect behaved.
  const yaml = fs.readFileSync(ACTION, "utf8");
  const alternations = [...yaml.matchAll(/\^\\\.\(([a-z|]+)\)\//g)].map((m) => m[1]);
  assert.strictEqual(alternations.length, 2, "expected exactly two path alternations");
  assert.strictEqual(alternations[0], alternations[1], "pass 1 and pass 2 disagree");
  assert.ok(alternations[0].split("|").includes("agents"), "agents missing from the alternation");
});
