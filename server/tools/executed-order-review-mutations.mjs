import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";

const root = await mkdtemp(path.join(tmpdir(), "executed-source-mutants-"));
const domain = "src/dispatch-executed-order-review.js";
const repository = "src/dispatch-executed-order-review-repository.js";
const address = "public/dispatch-address-guard.js";
const property = "test/dispatch/property/dispatch-executed-order-review.test.js";
const unit = "test/dispatch/unit/dispatch-executed-order-review.test.js";
const integration = "test/dispatch/integration/dispatch-executed-order-review.test.js";
const mutations = [
  ["source confirmation incorrectly gates save", domain, "candidate => key(candidate.orderRef)", "candidate => candidate.acknowledged && key(candidate.orderRef)"],
  ["arbitrary cargo accepted as source", domain, "same(itemRows(next.items || []), itemRows(review.sourceOrder.items || []))", "true"],
  ["item identity omitted from source proof", domain, "itemId: text(item.itemId ?? item.item_id)", "itemId: ''"],
  ["new source values reuse old review version", domain, "after: orderProjection(source)", "after: null"],
  ["blank address overwrites recorded address", address, "!text(previous[field]) || text(next[field])", "true"],
  ["unconfirmed warning is silently acknowledged", repository, "acknowledged: Boolean(row.acknowledged_at)", "acknowledged: true", "db"],
  ["stale token acknowledges the latest source", repository, "review.token === token && review.sourceAvailable", "review.sourceAvailable", "db"]
];
const results = [];
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
function run(files) {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map(file => path.join(root, file))],
    { cwd: root, env: environment, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
}
try {
  for (const directory of ["src", "public", "test", "migrations"]) {await cp(directory, path.join(root, directory), { recursive: true });}
  await cp("package.json", path.join(root, "package.json"));
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
  const originals = new Map(await Promise.all([domain, repository, address].map(async file => [file, await readFile(path.join(root, file), "utf8")])));
  assert.equal(run([unit, property]).status, 0, "Unmutated domain tests must pass before mutation");
  assert.equal(await runNodeTestFilesIsolated([path.join(root, integration)], { environment, label: "Mutation baseline" }), 0);
  for (const [name, file, from, to, mode] of mutations) {
    const source = originals.get(file);
    assert.ok(source.includes(from), `Mutation target missing: ${name}`);
    await writeFile(path.join(root, file), source.replace(from, to));
    assert.equal(spawnSync(process.execPath, ["--check", path.join(root, file)]).status, 0);
    let killed; let propertyKilled = null;
    if (mode === "db") {
      killed = (await runNodeTestFilesIsolated([path.join(root, integration)], { environment, label: name })) !== 0;
    } else {
      const result = run([unit, property]);
      killed = result.status !== 0 && /ERR_ASSERTION|Property failed|AssertionError/u.test(result.stdout + result.stderr);
      const properties = run([property]);
      propertyKilled = properties.status !== 0 && /ERR_ASSERTION|Property failed|AssertionError/u.test(properties.stdout + properties.stderr);
    }
    await writeFile(path.join(root, file), source);
    results.push({ name, killed, propertyKilled });
    assert.equal(killed, true, `Surviving mutant: ${name}`);
    if (mode !== "db") {assert.equal(propertyKilled, true, `Property blind spot: ${name}`);}
  }
  await writeFile("test-artifacts/executed-order-review/mutations.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ killed: results.length, total: mutations.length, propertyKilled: results.filter(result => result.propertyKilled).length }));
} finally { await rm(root, { recursive: true, force: true }); }
