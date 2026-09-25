import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const baseline = process.argv.includes("baseline");
const hashes = () => Object.fromEntries([...JSON.parse(fs.readFileSync("test-artifacts/load-followup/files.json", "utf8")).filter(file => file.startsWith("src/")),...(baseline?[]:['src/operator-load-state.js','src/operator-load-state-repository.js'])]
  .map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
const before = hashes();
fs.writeFileSync(`test-artifacts/load-followup/full-${baseline ? "baseline" : "candidate"}-starting-sources.json`, JSON.stringify(before,null,2));
const frontendHashes = () => Object.fromEntries(["public/operator.js", "public/operator.html", "public/service-worker.js", "public/operator-receiving-confirmation.css"]
  .map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
const frontendBefore = frontendHashes();
const groups = new Set(["infrastructure", "unit", "contracts", "property", "integration", "adversarial", "concurrency"]);
const files = fs.readdirSync("test/mbt", { recursive: true }).map(String)
  .filter(file => groups.has(file.split(path.sep)[0]) && /\.test\.(js|mjs)$/u.test(file))
  .filter(file => !baseline || !path.basename(file).startsWith("load-followup"))
  .sort().map(file => path.resolve("test/mbt", file));
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
process.exitCode = await runNodeTestFilesIsolated(files, { environment, label: `Load follow-up ${baseline ? "baseline" : "candidate"}` });
assert.deepEqual(hashes(), before, "Implementation changed during the full suite");
assert.deepEqual(frontendHashes(), frontendBefore, "Frontend changed during the full suite");
fs.writeFileSync(`test-artifacts/load-followup/full-${baseline ? "baseline" : "candidate"}-sources.json`, JSON.stringify(before, null, 2));
fs.writeFileSync(`test-artifacts/load-followup/full-${baseline ? "baseline" : "candidate"}-frontend-sources.json`, JSON.stringify(frontendBefore, null, 2));
