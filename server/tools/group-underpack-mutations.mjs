import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { describeIsolatedTestDatabase, isolatedTestDatabaseName, isolatedTestDatabaseUrl } from "../test/support/test-database-isolation.mjs";
const directory = path.resolve("test-artifacts/group-underpack-20260915"), moduleFile = "src/delivery-packing-progress.js";
const mutants = [
  ["remove the shared rounding allowance", moduleFile, "DELIVERY_PACK_ROUNDING_TOLERANCE = 0.1", "DELIVERY_PACK_ROUNDING_TOLERANCE = 0"],
  ["SQL retains phantom residuals", moduleFile, "AND ${remaining} <= ${DELIVERY_PACK_ROUNDING_TOLERANCE}", "AND ${remaining} <= 0"],
  ["dismiss a whole small package", moduleFile, "&& remaining < smallestUnit", ""],
  ["round sales-only shortages", moduleFile, "&& Number.isFinite(smallestUnit)", ""],
  ["truncate genuine fractional shortages", moduleFile, "Number((required - loaded - packed).toFixed(6))", "Math.floor(required - loaded - packed)"],
  ["lose the load tolerance boundary", "src/delivery-repository.js", "roundQuantity(Math.abs(remainingSalesQty - packedSalesQty))", "Math.abs(remainingSalesQty - packedSalesQty)"],
  ["lose the confirmation boundary", "src/delivery-repository.js", "roundQuantity(Math.abs((ceilUnits * unitSize) - sales))", "Math.abs((ceilUnits * unitSize) - sales)"],
  ["reject a valid load at the boundary", "src/delivery-repository.js", "roundQuantity(packedSalesQty - remainingSalesQty) > LOAD_SALES_QTY_TOLERANCE", "packedSalesQty > remainingSalesQty + LOAD_SALES_QTY_TOLERANCE"],
  ["lose the PWA whole-unit boundary", "public/operator.js", "Number(Math.abs((ceilUnits * unitSize) - sales).toFixed(6))", "Math.abs((ceilUnits * unitSize) - sales)"]
];
const boundary = describeIsolatedTestDatabase(process.env.DATABASE_URL, process.env);
const client = new pg.Client({ connectionString: boundary.adminUrl });
const root = mkdtempSync(path.join(tmpdir(), "group-underpack-mutants-")), results = [];
const originals = Object.fromEntries([...new Set(mutants.map(row => row[1]))].map(file => [file, readFileSync(file, "utf8")]));
function runMutant(index, propertyOnly, databaseUrl) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(propertyOnly ? ["--test-name-pattern=property:"] : []),
    "test/mbt/integration/group-underpack.test.js", "test/mbt/unit/group-underpack-ui.test.js", "test/dispatch/property/group-underpack-boundary.property.test.js"],
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
      const dbName = isolatedTestDatabaseName(`group-underpack-${process.pid}`, index * 2 + Number(propertyOnly));
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
