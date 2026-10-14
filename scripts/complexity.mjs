// Reads `vp lint -f json` from stdin and fails on functions with complexity above the limit.
// A lint rule takes one severity, so vite.config.ts warns at 20 and this enforces the hard limit.
import { readFileSync } from "node:fs";

const LIMIT = 30;

const { diagnostics } = JSON.parse(readFileSync(0, "utf8"));
const failures = diagnostics.filter((d) => {
  const score = d.message.match(/complexity of (\d+)/)?.[1];
  return d.code === "eslint(complexity)" && Number(score) > LIMIT;
});

for (const d of failures) {
  const message = d.message.replace(/Maximum allowed is \d+/, `Limit is ${LIMIT}`);
  console.error(`${d.filename}:${d.labels[0].span.line}: ${message}`);
}
process.exit(failures.length > 0 ? 1 : 0);
