import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["node_modules/c8/bin/c8.js", "--all", "--include=src/mbt/bin-planning-*.js",
  "--check-coverage", "--lines=100", "--statements=100", "--functions=100", "--branches=90",
  "--temp-directory=/tmp/bin-planning-c8", "--report-dir=test-artifacts/coverage", "--reporter=text", "--reporter=json",
  "--reporter=json-summary", process.execPath, "tools/bin-planning-suites.mjs", "feature"], { stdio: "inherit", env: process.env });
process.exitCode = result.status ?? 1;
