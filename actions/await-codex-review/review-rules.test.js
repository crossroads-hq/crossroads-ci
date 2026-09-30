const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// Both reviewers of this repository apply one rulebook: Codex reads AGENTS.md
// itself, and the Claude fallback is handed the same file as its contract.
const root = path.join(__dirname, "..", "..");

test("AGENTS.md carries the Code Review Rules section Codex looks for", () => {
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /^## Code Review Rules$/m);
});

test("the Claude fallback is pointed at the same rules as Codex", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  ai-review:\n"), ci.indexOf("\n  gate:\n"));
  assert.match(job, /^    with:\n      guidelines-file: AGENTS\.md$/m);
});

test("an AGENTS-only change schedules the job that validates its review rules", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const filter = ci.slice(ci.indexOf("            scripts:\n"), ci.indexOf("\n  workflow-lint:\n"));
  assert.match(filter, /^              - 'AGENTS\.md'$/m);
  const job = ci.slice(ci.indexOf("\n  scripts:\n"), ci.indexOf("\n  supply-chain:\n"));
  assert.match(job, /needs\.changes\.outputs\.scripts == 'true'/);
  assert.match(job, /run: node --test actions\/\*\/\*\.test\.js/);
});
