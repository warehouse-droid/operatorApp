import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const folder = path.resolve("test-artifacts/consolidation-group-planning/mutations");
mkdirSync(folder, { recursive: true });
const target = mkdtempSync(path.join(tmpdir(), "group-planning-mutations-"));
const testFile = "test/mbt/integration/consolidation-group-planning.test.js";
const sourceFile = "src/consolidation-load-repository.js";
const mutants = [
  { name: "ignore-group-date", from: "if (!missing.length) return orders;", to: "if (orders.length) return orders;" },
  { name: "accept-inactive-membership", from: "AND g.active=true AND g.order_type=source.type", to: "AND g.order_type=source.type" },
  { name: "accept-other-order-family", from: "AND g.order_type=source.type", to: "" },
  { name: "choose-conflicting-date", from: "dates?.length === 1", to: "dates?.length >= 1" }
];
const results = [];
function exercise(mutant, propertyOnly) {
  const run = spawnSync(process.execPath, ["--test", ...(propertyOnly ? ["--test-name-pattern=properties:"] : []), testFile], { cwd: target, encoding: "utf8", timeout: 90000 });
  assert.ifError(run.error);
  const output = `${run.stdout}${run.stderr}`;
  writeFileSync(path.join(folder, `${mutant.name}${propertyOnly ? "-property" : ""}.log`), output);
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|violates not-null constraint/, "Setup failures are not mutation kills");
  assert.ok(run.status === 1 && /not ok \d+ -/.test(output), `${mutant.name} survived`);
  results.push({ name: mutant.name, propertyOnly, killed: true });
}
try {
  for (const name of ["src", "public", "test", "migrations", "tools", "package.json"]) {cpSync(name, path.join(target, name), { recursive: true });}
  symlinkSync(path.resolve("node_modules"), path.join(target, "node_modules"));
  const file = path.join(target, sourceFile), original = readFileSync(file, "utf8");
  for (const mutant of mutants) {
    assert.equal(original.split(mutant.from).length, 2, `${mutant.name} needs a unique mutation point`);
    try {
      writeFileSync(file, original.replace(mutant.from, mutant.to));
      exercise(mutant, false);
      exercise(mutant, true);
    } finally {writeFileSync(file, original);}
    assert.equal(readFileSync(file, "utf8"), readFileSync(sourceFile, "utf8"));
  }
  const restored = spawnSync(process.execPath, ["--test", testFile], { cwd: target, encoding: "utf8", timeout: 90000 });
  assert.ifError(restored.error);
  writeFileSync(path.join(folder, "restored.log"), `${restored.stdout}${restored.stderr}`);
  assert.equal(restored.status, 0, "Restored sources must pass");
} finally {
  rmSync(target, { recursive: true, force: true });
  writeFileSync(path.join(folder, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ killed: results.filter((entry) => !entry.propertyOnly).length, propertyKilled: results.filter((entry) => entry.propertyOnly).length }));
