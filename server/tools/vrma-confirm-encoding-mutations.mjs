import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { describeIsolatedTestDatabase, isolatedTestDatabaseName, isolatedTestDatabaseUrl } from "../test/support/test-database-isolation.mjs";
const directory = path.resolve("test-artifacts/vrma-confirm-encoding-20260915"), route = "src/operator-yard-route.js", guard = "src/operator-yard-authorization.js";
const mutants = [
  ["leave reserved colon encoded", route, "decodeURIComponent(encodedId)", "decodeURI(encodedId)"],
  ["decode identifiers twice", route, "decodeURIComponent(encodedId)", "decodeURIComponent(decodeURIComponent(encodedId))"],
  ["decode the whole path before matching", route, '(originalUrl.split("?")[0] || "")', 'decodeURI(originalUrl.split("?")[0] || "")'],
  ["skip the stored order yard check", guard,
    'return assertOperatorOrderYard(req.operator, operatorRouteId(order[2]), { receiving: order[1] === "receiving", orderType: req.body?.orderType || req.query.orderType });', "return;"],
  ["decode an already decoded JSON identifier", guard, 'const savedId = req.body?.orderId ||',
    'const savedId = (req.body?.orderId ? operatorRouteId(String(req.body.orderId)) : "") ||']
];
const boundary = describeIsolatedTestDatabase(process.env.DATABASE_URL, process.env);
const client = new pg.Client({ connectionString: boundary.adminUrl });
const root = mkdtempSync(path.join(tmpdir(), "vrma-encoding-mutants-")), results = [];
const originals = Object.fromEntries([route, guard].map(file => [file, readFileSync(file, "utf8")]));
function runMutant(index, propertyOnly, databaseUrl) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(propertyOnly ? ["--test-name-pattern=property:"] : []),
    "test/mbt/unit/vrma-confirm-encoding.test.js", "test/mbt/integration/vrma-confirm-encoding.test.js"],
  { cwd: root, encoding: "utf8", maxBuffer: 15e6, env: { ...process.env, DATABASE_URL: databaseUrl, NODE_V8_COVERAGE: "" } });
  if (result.error) {throw result.error;}
  const output = result.stdout + result.stderr;
  const killed = result.status !== 0 && /ERR_ASSERTION|Counterexample:/.test(output);
  writeFileSync(`${directory}/mutant-${index}-${propertyOnly ? "property" : "full"}.log`, output);
  return killed;
}
try {
  for (const folder of ["src", "public", "test"]) {cpSync(folder, path.join(root, folder), { recursive: true });}
  cpSync("package.json", path.join(root, "package.json"));
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  await client.connect();
  for (const [index, [name, file, before, after]] of mutants.entries()) {
    assert.equal(originals[file].split(before).length, 2, name);
    writeFileSync(path.join(root, file), originals[file].replace(before, after));
    for (const propertyOnly of [false, true]) {
      const dbName = isolatedTestDatabaseName(`vrma-encoding-${process.pid}`, index * 2 + Number(propertyOnly));
      await client.query(`CREATE DATABASE "${dbName}" TEMPLATE mbt_test`);
      try {
        const killed = runMutant(index, propertyOnly, isolatedTestDatabaseUrl(process.env.DATABASE_URL, dbName));
        results.push({ name, propertyOnly, killed }); assert(killed, `${name} survived`);
      } finally { await client.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); }
    }
    writeFileSync(path.join(root, file), originals[file]);
  }
  writeFileSync(`${directory}/mutations.json`, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results));
} finally { await client.end(); rmSync(root, { recursive: true, force: true }); }
