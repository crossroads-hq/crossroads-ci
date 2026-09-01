const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const workflow = fs.readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "_ai-review.yml"),
  "utf8"
);

test("a prior Codex-only success is revalidated instead of deduplicated", () => {
  assert.match(
    workflow,
    /select\(any\(\.steps\[\]\?;\s*\.name == "Confirm a review actually reached the pull request" and\s*\.conclusion == "success"\)\)/s
  );
  assert.doesNotMatch(
    workflow,
    /select\(\(\.name \| endswith\("AI review"\)\) and \.conclusion == "success"\)\]\s*\| length/
  );
});
