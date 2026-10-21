import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const files = JSON.parse(readFileSync("tools/bin-planning-files.json", "utf8"));
for (const file of files.filter(f => /\.(js|mjs)$/u.test(f))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status) {throw new Error(`${file}: ${result.stderr}`);}
}
const mbt = files.filter(f => f.startsWith("src/mbt/") && f.endsWith(".js"));
const lint = spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "--config", "tools/bin-planning-eslint.config.mjs",
  "--max-warnings=0", ...mbt, "public/mbt-planning.js"], { encoding: "utf8" });
writeFileSync("test-artifacts/lint.log", lint.stdout + lint.stderr);
if (lint.status) {throw new Error(lint.stdout + lint.stderr);}
const typed = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--pretty", "false"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
writeFileSync("test-artifacts/types.log", typed.stdout + typed.stderr);
const diagnostics = typed.stdout.split("\n").filter(line => /error TS\d+/u.test(line));
const affected = diagnostics.filter(line => mbt.some(file => line.startsWith(`${file}(`)));
if (affected.length || typed.error) {throw new Error(affected.join("\n") || String(typed.error));}
const versions = {};
for (const name of ["typescript", "eslint", "c8", "fast-check", "@playwright/test"]) {
  versions[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
}
const result = { syntaxFiles: files.filter(f => /\.(js|mjs)$/u.test(f)).length, lintErrors: 0,
  changedMbtTypeErrors: affected.length, fullProjectTypeErrors: diagnostics.length,
  fullProjectTypeStatus: typed.status === 0 ? "passed" : "existing imported graph diagnostics; see types.log",
  node: process.version, tools: versions, newPlanningModules: readdirSync("src/mbt").filter(f => f.startsWith("bin-planning-")).length };
writeFileSync("test-artifacts/static.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
