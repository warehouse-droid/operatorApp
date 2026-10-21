import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { closeDb, query } from "../src/db.js";

const url = new URL(process.env.DATABASE_URL);
assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(url.hostname, "db");
assert.equal(url.pathname, "/mbt_test");
assert.equal(url.username, "mbt_test");
const out = "test-artifacts/driver-reopen-replan-mutations";
await mkdir(out, { recursive: true });
const sqlPath = "migrations/267_driver_reopen_completion_cycles.sql";
const originalSql = await readFile(sqlPath, "utf8");
const mutants = [
  { name: "retain-reopened-completion", sql: originalSql.replace("correction.id > COALESCE(event.reopen_correction_id, 0)", "correction.id < COALESCE(event.reopen_correction_id, 0)") },
  { name: "forget-group-members", sql: originalSql.replaceAll("OR correction.result->'physicalVisitJobIds' ? event.completion_evidence_id", "OR false") },
  { name: "discard-new-completion-cycle", sql: originalSql.replace("completion_evidence_id, COALESCE(reopen_correction_id, 0)", "completion_evidence_id") },
  { name: "accept-stale-completion", sql: originalSql.replace("raw_completed_at <= reopened_at", "raw_completed_at > reopened_at") },
  { name: "omit-immediate-catalog-refresh", file: "src/server.js", before: 'await refreshDispatchOrderCatalogRefsNow(result.orderRefs || [], { source: "driver-pwa-reopen" });', after: "void 0;" },
  { name: "omit-durable-catalog-refresh", file: "src/driver-pwa-repository.js", before: 'await enqueueDispatchOrderCatalogRefresh({ orderRef, source: "driver-pwa-reopen" });', after: "void orderRef;" }
];
const results = [];
async function resetIsolatedSchema() {
  // Release table locks between statements instead of holding thousands while
  // dropping the complete application schema in one transaction.
  const tables = await query("SELECT format('DROP TABLE IF EXISTS %I.%I CASCADE','public',tablename) AS statement FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for (const table of tables.rows) { await query(table.statement); }
  await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
}
async function removeTemporary(directory) {
  if (directory) { await rm(directory, { recursive: true, force: true }); }
}
async function prepareSourceMutant(mutant) {
  const directory = await mkdtemp("/tmp/driver-reopen-mutant-");
  for (const name of ["src", "public", "migrations", "package.json"]) {
    await cp(name, `${directory}/${name}`, { recursive: true });
  }
  await symlink("/app/node_modules", `${directory}/node_modules`);
  await mkdir(`${directory}/test/mbt/integration`, { recursive: true });
  await cp("test/mbt/integration/driver-reopen-replan.test.js", `${directory}/test/mbt/integration/driver-reopen-replan.test.js`);
  const source = await readFile(`${directory}/${mutant.file}`, "utf8");
  assert.ok(source.includes(mutant.before));
  await writeFile(`${directory}/${mutant.file}`, source.replace(mutant.before, mutant.after));
  return directory;
}
try {
  for (const mutant of mutants) {
    await resetIsolatedSchema();
    const migration = spawnSync("node", ["src/migrate.js"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(migration.status, 0, migration.stderr);
    let temporary;
    let cwd = process.cwd();
    try {
      if (mutant.sql) {
        assert.notEqual(mutant.sql, originalSql);
        await query(mutant.sql);
      } else {
        temporary = await prepareSourceMutant(mutant);
        cwd = temporary;
      }
      const result = spawnSync("node", ["--test", "--test-concurrency=1", "test/mbt/integration/driver-reopen-replan.test.js"], { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      await writeFile(`${out}/${mutant.name}.log`, result.stdout + result.stderr);
      assert.notEqual(result.status, 0, `Mutation survived: ${mutant.name}`);
      assert.match(result.stdout, /not ok .*?(reopen|recompletion|visit)/u, "mutants must fail a behavior assertion, not imports or setup");
      assert.match(result.stdout, /code: 'ERR_ASSERTION'/u, "mutation must be caught by a behavior assertion");
      assert.doesNotMatch(result.stdout + result.stderr, /failureType: 'hookFailed'|ERR_MODULE_NOT_FOUND|EACCES|SyntaxError/u);
      results.push({ name: mutant.name, killed: true });
      console.log(JSON.stringify(results.at(-1)));
    } finally {
      await removeTemporary(temporary);
    }
  }
  await writeFile(`${out}/result.json`, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ killed: results.length, total: mutants.length }));
} finally { await closeDb(); }
