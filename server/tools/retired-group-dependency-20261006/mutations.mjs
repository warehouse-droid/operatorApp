import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

const root = "/tmp/retired-group-mutants";
const relative = "src/order-dependency-repository.js";
rmSync(root, { recursive: true, force: true });
mkdirSync(root);
for (const name of ["src", "test", "public", "package.json"]) {
  cpSync(name, `${root}/${name}`, { recursive: true });
}
symlinkSync("/app/node_modules", `${root}/node_modules`, "dir");
const original = readFileSync(relative, "utf8");
const mutants = [
  ["ignore-revision", "Number(current.rows[0].revision) === Number(plan.revision)", "true"],
  ["omit-save-lock", 'await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);', "void DISPATCH_FLEET_PLANNING_LOCK;"],
  ["treat-active-groups-as-retired", "WHERE active=false AND lower(group_ref)=ANY($1::text[])", "WHERE lower(group_ref)=ANY($1::text[])"],
  ["collapse-multiple-sources", "allocations.every(line => line.salesLineId && text(line.sourceOrderRef).toLowerCase() === canonicalRef)", "allocations.length > 0"]
];
const results = [];
try {
  for (const [name, before, after] of mutants) {
    assert.equal(original.split(before).length, 2, `unique mutation anchor: ${name}`);
    writeFileSync(`${root}/${relative}`, original.replace(before, after));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/mbt/integration/retired-group-dependency.test.js"],
      { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
    const log = result.stdout + result.stderr;
    writeFileSync(`test-artifacts/mutation-${name}.log`, log);
    const killed = result.status !== 0 && /^# fail [1-9]/mu.test(log)
      && /ERR_ASSERTION|Property failed/u.test(log) && !/ERR_MODULE_NOT_FOUND/u.test(log);
    results.push({ name, killed, exit: result.status });
    assert.equal(killed, true, `mutant must fail on behavior: ${name}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  writeFileSync("test-artifacts/mutations.json", JSON.stringify(results, null, 2) + "\n");
}
console.log(JSON.stringify({ mutants: results.length, killed: results.filter(result => result.killed).length }));
