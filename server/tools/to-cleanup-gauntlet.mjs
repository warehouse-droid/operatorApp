import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const directory = "test-artifacts/to-cleanup-20260915/final";
rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true });
const coverage = `${directory}/coverage`, results = [];
const run = (name, args, covered = false) => {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 25 * 1024 * 1024,
    env: { ...process.env, NODE_V8_COVERAGE: covered ? coverage : "" } });
  if (result.error) throw result.error;
  writeFileSync(`${directory}/${name}.log`, result.stdout + result.stderr);
  results.push({ name, exitCode: result.status }); console.log(JSON.stringify(results.at(-1)));
  assert.equal(result.status, 0, `${name} failed; see ${directory}/${name}.log`);
};
run("focused", ["tools/to-cleanup-suite.mjs", "focused"], true);
run("static", ["tools/to-cleanup-static.mjs"]);
run("mutations", ["tools/to-cleanup-mutations.mjs"]);
run("rehearsal", ["tools/to-cleanup-rehearse.mjs"], true);
run("coverage", ["node_modules/c8/bin/c8.js", "report", "--all=false", "--check-coverage=false", `--temp-directory=${coverage}`,
  `--reports-dir=${directory}/c8`, "--include=src/dispatch-fulfilled-to-*.js", "--include=tools/to-cleanup-domain.mjs", "--include=tools/to-cleanup-repository.mjs",
  "--reporter=json", "--reporter=json-summary", "--reporter=text"]);
run("changed-coverage", ["tools/to-cleanup-coverage.mjs"]);
writeFileSync(`${directory}/results.json`, `${JSON.stringify(results, null, 2)}\n`);
