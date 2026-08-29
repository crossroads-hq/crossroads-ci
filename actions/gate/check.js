// The gate logic, in a file rather than a shell heredoc: the composite must
// run on every runner in the fleet, and the Windows backup has no bash --
// its first routed job died on `bash: command not found`. A file needs only
// node, which every runner carries.

function fail(message) {
  console.error(message);
  process.exit(1);
}

let results;
try {
  results = JSON.parse(process.env.RESULTS);
} catch (error) {
  // A caller builds `results` by interpolating expressions into a JSON
  // literal; one unquoted value and this is the only thing standing between a
  // malformed payload and a gate that checks nothing.
  fail(`results is not valid JSON: ${error.message}`);
}

if (results === null || typeof results !== "object" || Array.isArray(results)) {
  fail("results must be a JSON object mapping job name to result.");
}

// An empty map is the failure this gate exists to prevent: it would pass every
// entry it was given, having been given none. The gate never legitimately has
// nothing to check -- a caller with no required jobs does not need a gate.
if (Object.keys(results).length === 0) {
  fail("results is empty; a gate cannot pass a run it was asked to check nothing about.");
}

// One name per line so multi-word labels like "Workflow lint" survive intact.
const allowSkipped = new Set(
  (process.env.ALLOW_SKIPPED || "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
);

let failed = false;
for (const [name, result] of Object.entries(results)) {
  console.log(`${name}: ${result}`);
  if (result === "success") continue;
  if (result === "skipped" && allowSkipped.has(name)) continue;
  console.error(
    result === "cancelled"
      ? `${name} was cancelled while this run stayed live; a required job that did not finish cannot pass the gate.`
      : `${name} did not pass (${result}).`
  );
  failed = true;
}
process.exit(failed ? 1 : 0);
