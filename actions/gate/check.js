// The gate logic, in a file rather than a shell heredoc: the composite must
// run on every runner in the fleet, and the Windows backup has no bash --
// its first routed job died on `bash: command not found`. A file needs only
// node, which every runner carries.
const results = JSON.parse(process.env.RESULTS);
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
