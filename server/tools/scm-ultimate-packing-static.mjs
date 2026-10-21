import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Linter } from "eslint";

const directory = "test-artifacts/scm-ultimate-packing-20261005";
const changed = JSON.parse(readFileSync(`${directory}/changed-lines.json`, "utf8"));
const globals = Object.fromEntries([
  "process", "Buffer", "console", "fetch", "URL", "URLSearchParams", "AbortController", "AbortSignal", "Blob",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "structuredClone",
  "document", "window", "localStorage", "confirm", "alert", "navigator", "smartState", "smartScmApp", "smartApi", "smartWork",
  "smartRender", "smartEscape", "smartNumber", "smartPercent", "smartDate", "smartPill", "smartCanWrite", "smartCoverageEvidence",
  "smartProposalManualPriority", "smartLineOrderRows", "smartLineOrderHelp", "smartLineOrderEditable", "smartLoadBootstrap",
  "smartShowNotice", "smartFilteredProposals", "smartRunPlan", "smartNormalizeSource", "smartRefreshVendorReplies"
].map((name) => [name, "writable"]));
const rules = { complexity: ["error", 12], curly: ["error", "all"], eqeqeq: ["error", "always"],
  "max-depth": ["error", 4], "no-constant-condition": "error", "no-duplicate-imports": "error",
  "no-shadow": "error", "no-undef": "error", "no-unreachable": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
  "no-var": "error", "prefer-const": "error" };
const linter = new Linter();
const reports = [];
for (const file of ["src/smart-scm-planning-repository.js", "public/scm-smart-proposals.js"]) {
  const verify = (text) => linter.verify(text, { languageOptions: { ecmaVersion: "latest", sourceType: "module", globals }, rules }, { filename: file });
  const before = verify(readFileSync(`${directory}/baseline/${file}`, "utf8"));
  const after = verify(readFileSync(file, "utf8"));
  const key = (message) => `${message.ruleId}:${message.message}`;
  const counts = (messages) => messages.reduce((map, message) => map.set(key(message), (map.get(key(message)) || 0) + 1), new Map());
  const oldCounts = counts(before), currentCounts = counts(after);
  const newMessages = after.filter((message) => changed[file].includes(message.line)
    || (currentCounts.get(key(message)) || 0) > (oldCounts.get(key(message)) || 0));
  reports.push({ file, baselineDiagnostics: before.length, candidateDiagnostics: after.length, newMessages });
}
const types = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit"],
  { encoding: "utf8", timeout: 60000 });
writeFileSync(`${directory}/types.log`, `${types.stdout || ""}${types.stderr || ""}`);
const sandbox = mkdtempSync(path.join(tmpdir(), "scm-ultimate-types-"));
let baselineTypes;
try {
  for (const folder of ["src", "public"]) {
    symlinkSync(path.resolve(directory, "baseline", folder), path.join(sandbox, folder), "dir");
  }
  for (const folder of ["node_modules", "tools", "test", "contracts"]) {
    symlinkSync(path.resolve(folder), path.join(sandbox, folder), "dir");
  }
  for (const file of ["tsconfig.mbt.json", "package.json"]) copyFileSync(file, path.join(sandbox, file));
  baselineTypes = spawnSync(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "--project", "tsconfig.mbt.json", "--noEmit"],
    { cwd: sandbox, encoding: "utf8", timeout: 60000 });
} finally { rmSync(sandbox, { recursive: true, force: true }); }
writeFileSync(`${directory}/types-baseline.log`, `${baselineTypes.stdout || ""}${baselineTypes.stderr || ""}`);
const diagnostics = (run) => (run.stdout || "").split("\n").filter((line) => /error TS\d+:/.test(line));
const oldTypeErrors = diagnostics(baselineTypes), currentTypeErrors = diagnostics(types);
const newTypeErrors = currentTypeErrors.filter((line) => !oldTypeErrors.includes(line));
const require = createRequire(import.meta.url);
const versions = Object.fromEntries(["eslint", "typescript", "fast-check", "c8"].map((name) => [name, require(`${name}/package.json`).version]));
const result = { node: process.version, versions, lint: reports, typeExitCode: types.status,
  typeBaselineExitCode: baselineTypes.status, baselineTypeErrors: oldTypeErrors.length,
  candidateTypeErrors: currentTypeErrors.length, newTypeErrors,
  typeScope: "Existing tsconfig.mbt.json; legacy planning/browser JavaScript is not fully checked by this project configuration." };
writeFileSync(`${directory}/static.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
assert.ok(reports.every((report) => report.newMessages.length === 0), "New lint diagnostics must be resolved");
assert.ok(!types.error && !baselineTypes.error, "Type checks must complete");
assert.ok(types.status === 0 || currentTypeErrors.length > 0, "Type check failed without diagnostics");
assert.deepEqual(newTypeErrors, [], "Existing TypeScript project must introduce zero new errors");
