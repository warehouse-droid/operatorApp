import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const directory = "test-artifacts/to-cleanup-20260915";
const baseline = "/workspace/docker/backups/to-cleanup-20260915/current-runtime";
const files = ["src/dispatch-fulfilled-to-policy.js", "src/dispatch-fulfilled-to-repository.js", "src/dispatch-fulfilled-so-repository.js", "src/server.js",
  "src/receiving-repository.js", "public/dispatch.js", "tools/to-cleanup-domain.mjs", "tools/to-cleanup-repository.mjs",
  "tools/to-cleanup-cli.mjs", "tools/to-cleanup-netsuite-read.mjs", "tools/to-cleanup-rehearse.mjs", "tools/to-cleanup-mutations.mjs"];
const lint = new ESLint({ overrideConfigFile: "tools/to-cleanup-eslint.config.mjs" });
const current = [], prior = [];
for (const file of files) {
  for (const [root, bucket] of [[".", current], [baseline, prior]]) {
    if (!existsSync(`${root}/${file}`)) continue;
    const source = readFileSync(`${root}/${file}`, "utf8"), lines = source.split("\n");
    const result = (await lint.lintText(source, { filePath: file }))[0];
    bucket.push(...result.messages.map(message => ({ file, rule: message.ruleId, message: message.message, source: lines[message.line - 1]?.trim() })));
  }
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
}
const count = values => { const result = new Map(); for (const value of values) { const key = JSON.stringify(value); result.set(key, (result.get(key) || 0) + 1); } return result; };
const before = count(prior), after = count(current), added = [...after].filter(([key, n]) => n > (before.get(key) || 0));
writeFileSync(`${directory}/final/lint-baseline.json`, JSON.stringify(prior, null, 2));
writeFileSync(`${directory}/final/lint-current.json`, JSON.stringify(current, null, 2));
writeFileSync(`${directory}/final/lint-new.json`, JSON.stringify(added, null, 2));
assert.equal(added.length, 0, `New lint findings: ${JSON.stringify(added)}`);
const types = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { encoding: "utf8", maxBuffer: 25 * 1024 * 1024 });
writeFileSync(`${directory}/final/types-current.log`, types.stdout + types.stderr);
const typeKeys = text => text.split("\n").filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ""));
const oldTypes = count(typeKeys(readFileSync(`${directory}/types-baseline.log`, "utf8"))), newTypes = count(typeKeys(types.stdout + types.stderr));
const addedTypes = [...newTypes].filter(([key, n]) => n > (oldTypes.get(key) || 0));
writeFileSync(`${directory}/final/types-new.json`, JSON.stringify(addedTypes, null, 2));
assert.equal(addedTypes.length, 0, `New type diagnostics: ${JSON.stringify(addedTypes)}`);
console.log(JSON.stringify({ syntaxChecked: files.length, baselineLint: prior.length, currentLint: current.length, newLint: 0,
  baselineTypeDiagnostics: [...oldTypes.values()].reduce((a, b) => a + b, 0), currentTypeDiagnostics: [...newTypes.values()].reduce((a, b) => a + b, 0), newTypeDiagnostics: 0 }));
