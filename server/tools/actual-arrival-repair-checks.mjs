import fs from "node:fs";
import { spawnSync } from "node:child_process";
const manifest = JSON.parse(fs.readFileSync(new URL("./actual-arrival-repair-files.json", import.meta.url), "utf8"));
const artifact = "test-artifacts/actual-arrival-repair";
const mode = process.argv[2] || "focused";
const label = process.argv[3] || "current";
function run(name, command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if (result.error) {throw result.error;}
  fs.writeFileSync(`${artifact}/${name}-${label}.log`, result.stdout + result.stderr);
  console.log(JSON.stringify({ name, status: result.status }));
  return result;
}
if (mode === "static") {
  const files = [...manifest.production, ...manifest.tests, "tools/actual-arrival-repair-checks.mjs"].filter(file => /\.(js|mjs)$/u.test(file) && fs.existsSync(file));
  for (const file of files) {
    if (spawnSync(process.execPath, ["--check", file]).status !== 0) {throw new Error(`Syntax: ${file}`);}
  }
  run("lint", "node_modules/.bin/eslint", ["--config", new URL("./actual-arrival-repair-eslint.config.mjs", import.meta.url).pathname, "--format", "json", ...files]);
  run("types", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"]);
} else {
  let files = manifest.tests;
  if (mode === "random") {files = [...files].sort((a, b) => a.split("").reverse().join("").localeCompare(b.split("").reverse().join("")));}
  if (run(mode, process.execPath, ["--test", "--test-concurrency=1", ...files]).status !== 0) {process.exitCode = 1;}
  if (mode === "focused") {
    for (const name of ["dispatch-forecast", "dispatch-stop-visit", "dispatch-statistics-v2", "driver-gps-gate", "driver-location-reliability", "driver-consolidated-stops"]) {
      const file = `src/${name}-harness.js`;
      if (!fs.existsSync(file)) {continue;}
      if (run(name, process.execPath, [file]).status !== 0) {process.exitCode = 1;}
    }
  }
}
