import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const mode = process.argv[2] || "current";
const out = `test-artifacts/driver-reopen-replan-${mode}-static`;
mkdirSync(out, { recursive: true });
function run(label, args) {
  const result = spawnSync("node", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(`${out}/${label}.log`, result.stdout + result.stderr);
  return result;
}
for (const name of ["src/server.js", "src/driver-pwa-repository.js", "test/mbt/integration/driver-reopen-replan.test.js", "tools/driver-reopen-replan-static.mjs", "tools/driver-reopen-replan-migration.mjs", "tools/driver-reopen-replan-mutations.mjs", "tools/driver-reopen-replan-final.mjs", "tools/driver-reopen-replan-live.mjs"]) {
  assert.equal(run(name.replaceAll("/", "-"), ["--check", name]).status, 0);
}
const lint = run("lint", ["node_modules/eslint/bin/eslint.js", "--config", "tools/driver-reopen-replan-eslint.config.mjs", "--format", "json", "src/server.js", "src/driver-pwa-repository.js", "test/mbt/integration/driver-reopen-replan.test.js", "tools/driver-reopen-replan-static.mjs", "tools/driver-reopen-replan-migration.mjs", "tools/driver-reopen-replan-mutations.mjs", "tools/driver-reopen-replan-final.mjs", "tools/driver-reopen-replan-live.mjs"]);
const messages = JSON.parse(lint.stdout).flatMap(file => file.messages.map(message => ({ file: file.filePath.replace(/^.*\/app\//u, ""), rule: message.ruleId, message: message.message })));
writeFileSync(`${out}/lint-messages.json`, JSON.stringify(messages, null, 2) + "\n");
assert.equal(messages.filter(message => message.file.startsWith("tools/") || message.file.startsWith("test/")).length, 0, "new test and tooling lint must pass");
const types = run("types", ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit"]);
const diagnostics = (types.stdout + types.stderr).split("\n").filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, ""));
writeFileSync(`${out}/type-messages.json`, JSON.stringify(diagnostics, null, 2) + "\n");
const versions = { node: process.version };
for (const name of ["eslint", "typescript", "c8", "pg", "fast-check"]) {
  const imported = await import(`${name}/package.json`, { with: { type: "json" } });
  versions[name] = imported.default.version;
}
writeFileSync(`${out}/versions.json`, JSON.stringify(versions, null, 2) + "\n");
console.log(JSON.stringify({ mode, syntax: "passed", lintDiagnostics: messages.length, typeDiagnostics: diagnostics.length, typeExit: types.status, versions }));
