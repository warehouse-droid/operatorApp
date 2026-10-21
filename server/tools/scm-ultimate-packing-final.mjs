import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = "test-artifacts/scm-ultimate-packing-20261005";
const final = `${directory}/final`;
mkdirSync(`${final}/coverage`, { recursive: true });
const reports = [];
const stages = [
  ["focused", ["--test", "--test-concurrency=1", "test/mbt/unit/scm-ultimate-packing.test.js",
    "test/mbt/property/scm-ultimate-packing.property.test.js", "test/mbt/integration/scm-ultimate-packing.test.js"], true, 120000],
  ["static", ["tools/scm-ultimate-packing-static.mjs"], false, 180000],
  ["candidate", ["tools/scm-ultimate-packing-suites.mjs", "final-candidate"], false, 1200000],
  ["shuffled", ["tools/scm-ultimate-packing-suites.mjs", "final-shuffled"], false, 1200000],
  ["replay", ["tools/scm-ultimate-packing-replay.mjs"], true, 120000],
  ["mutations", ["tools/scm-ultimate-packing-mutations.mjs"], false, 600000],
  ["runtime", ["tools/scm-ultimate-packing-runtime.mjs"], true, 120000],
  ["coverage", ["tools/scm-ultimate-packing-coverage.mjs"], false, 60000]
];
for (const [label, args, coverage, timeout] of stages) {
  if (process.env.SCM_PACKING_PREFLIGHT === "1" && ["candidate", "shuffled"].includes(label)) continue;
  const started = Date.now();
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout,
    env: { ...process.env, NODE_V8_COVERAGE: coverage ? path.resolve(final, "coverage") : "",
      SCM_PACKING_SHUFFLE: label === "shuffled" ? "1" : "0" } });
  writeFileSync(`${final}/${label}.log`, `${run.stdout || ""}${run.stderr || ""}`);
  reports.push({ label, exitCode: run.status, seconds: (Date.now() - started) / 1000, error: run.error?.message || null });
  writeFileSync(`${final}/stages.json`, `${JSON.stringify(reports, null, 2)}\n`);
  console.log(JSON.stringify(reports.at(-1)));
  assert.equal(run.status, 0, `${label} failed; inspect ${final}/${label}.log`);
}
for (const file of ["static.json", "types.log", "types-baseline.log", "replay-report.json"]) {
  copyFileSync(`${directory}/${file}`, `${final}/${file}`);
}
const manifest = JSON.parse(readFileSync(`${directory}/source-manifest.json`, "utf8"));
console.log(JSON.stringify({ completed: true, sourceTreeHash: manifest.sourceTreeHash, stages: reports.length }));
