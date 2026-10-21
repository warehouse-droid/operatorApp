import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = await mkdtemp(path.join(tmpdir(), "special-po-mutants-"));
const route = "src/dispatch-po-route-projection.js";
const history = "src/dispatch-history-mode.js";
const completion = "src/dispatch-completion-repository.js";
const migration = "migrations/213_dispatch_special_po_link_coverage.sql";
const unit = "test/dispatch/unit/dispatch-special-po-lifecycle.test.js";
const property = "test/dispatch/property/dispatch-special-po-lifecycle.test.js";
const integration = "test/dispatch/integration/dispatch-special-po-lifecycle.test.js";
const mutations = [
  ["native coverage ignored", route, "Math.min(allocatedSales / totalSales, 1)", "0", true],
  ["partial special freight hidden too early", route, "Math.min(allocatedSales / totalSales, 1)", "Math.min(allocatedSales / totalSales * 2, 1)", true],
  ["inactive allocations count as cargo", route, "return !status || status === \"active\";", "return Boolean(status) || true;", true],
  ["native coverage discarded without explicit pallets", route, "Math.max(\n        matches.reduce", "Math.min(\n        matches.reduce", true],
  ["PO Driver evidence omitted by server guard", history, "completion.metadata->>'directPoLink' = 'true'", "completion.metadata->>'directPoLink' = 'false'", false],
  ["completed PO card remains draggable", completion, "dispatchPlanningRestricted: true,", "dispatchPlanningRestricted: false,", false],
  ["special display pallets prevent historical completion", migration,
    "line.item_id IS DISTINCT FROM 2055 OR COALESCE(line.quantity, 0) <= 0", "true", false]
];
function run(files) {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map((file) => path.join(root, file))],
    { cwd: root, env: process.env, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
}
const results = [];
try {
  for (const directory of ["src", "public", "test", "migrations"]) {
    await cp(directory, path.join(root, directory), { recursive: true });
  }
  await cp("package.json", path.join(root, "package.json"));
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
  const originals = new Map(await Promise.all([route, history, completion, migration].map(async (file) =>
    [file, await readFile(path.join(root, file), "utf8")])));
  assert.equal(run([unit, property, integration]).status, 0, "Unmutated baseline must pass");
  for (const [name, file, from, to, propertyApplicable] of mutations) {
    const source = originals.get(file);
    assert.ok(source.includes(from), `Missing mutation target: ${name}`);
    await writeFile(path.join(root, file), source.replace(from, to));
    const mutated = run([unit, property, integration]);
    const killed = mutated.status !== 0 && /ERR_ASSERTION|Property failed/u.test(mutated.stdout + mutated.stderr);
    let propertyKilled = null;
    if (propertyApplicable) {
      const result = run([property]);
      propertyKilled = result.status !== 0 && /Property failed/u.test(result.stdout + result.stderr);
    }
    await writeFile(path.join(root, file), source);
    results.push({ name, killed, propertyKilled });
    assert.equal(killed, true, `Survived: ${name}`);
    if (propertyApplicable) { assert.equal(propertyKilled, true, `Property blind spot: ${name}`); }
  }
  assert.equal(run([unit, property, integration]).status, 0, "Restored sources must pass");
  await writeFile("test-artifacts/mutations.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ killed: results.length, total: mutations.length,
    propertyKilled: results.filter((result) => result.propertyKilled).length }));
} finally { await rm(root, { recursive: true, force: true }); }
