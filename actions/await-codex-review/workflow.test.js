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

test("the Claude fallback uses the lower-cost Sonnet model", () => {
  assert.match(
    workflow,
    /claude_args:\s*\|\s*\n\s*--model sonnet\s*\n\s*--max-turns/s
  );
});

test("the workflow pins the detector with clean-comment support", () => {
  assert.match(
    workflow,
    /uses: crossroads-hq\/crossroads-ci\/actions\/await-codex-review@c863c4b2c0e3614b50986277a22b962bc98402ee # await-codex-review v1/
  );
});

test("the Codex delivery wait covers the observed review latency", () => {
  assert.match(
    workflow,
    /codex-wait-seconds:[\s\S]*?default: 300/
  );
});
