import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const folder = path.resolve("test-artifacts/operator-posting-latency/mutations");
mkdirSync(folder, { recursive: true });
const target = mkdtempSync(path.join(tmpdir(), "posting-mutations-"));
const unit = "test/mbt/unit/operator-posting-latency.test.js";
const queue = "test/mbt/integration/operator-posting-photos.test.js";
const mutants = [
  { name: "missing-http-timing", file: "src/netsuite.js", from: 'operation: "netsuite.http", method: options.method', to: 'operation: "missing.http", method: options.method', test: "test/mbt/integration/operator-posting-http-timing.test.js" },
  { name: "upload-before-completion", file: "src/operator-netsuite-posting-photo-queue.js", from: "AND coalesce(c.status,b.status)='completed'", to: "AND true", test: queue },
  { name: "stale-lease-writes", file: "src/operator-netsuite-posting-photo-queue.js", from: "lease_token=$2 AND lease_expires_at>now()", to: "($2::uuid IS NOT NULL) AND lease_expires_at>now()", test: queue },
  { name: "overwrite-unrelated-proof", file: "src/operator-netsuite-posting-photo-queue.js", from: "WHERE id=ANY($1::bigint[])", to: "WHERE $1::bigint[] IS NOT NULL", test: queue },
  { name: "lose-replacement", file: "src/operator-netsuite-posting-photos.js", from: "ref === original ? replacement : ref", to: "ref === original ? original : ref", test: unit, property: true },
  { name: "truncate-photo", file: "src/operator-netsuite-posting-photos.js", from: "return { bytes, mimeType:", to: "return { bytes: bytes.subarray(1), mimeType:", test: unit, property: true },
  { name: "upfront-r2-receipt", file: "public/operator.js", from: "const deferPhotos = !localOnlyPosting && receiptNetSuitePolicy?.effective;", to: "const deferPhotos = false;", test: "test/mbt/unit/operator-posting-photo-client.test.js" },
  { name: "received-po-reappears", file: "src/receiving-repository.js", from: '"ro.receipt_status IS DISTINCT FROM \'received\'", ', to: "", test: "test/mbt/integration/operator-receiving-completed.test.js" },
  { name: "stale-receiving-search", file: "public/operator.js", from: '  receivingSearch = "";\n  receivingItemSearch = "";\n  receivingSelectedId = null;', to: '  receivingItemSearch = "";\n  receivingSelectedId = null;', test: "test/mbt/unit/operator-receiving-return.test.js" },
  { name: "ignore-lost-photo-lease", file: "src/operator-netsuite-posting-photo-worker.js", from: "if (!await complete(job, ref))", to: "if (await complete(job, ref))", test: unit }
];
const results = [];
function exercise(mutant, propertyOnly = false) {
  const args = ["--test", ...(propertyOnly ? ["--test-name-pattern=generated cases"] : []), mutant.test];
  const run = spawnSync(process.execPath, args, { cwd: target, encoding: "utf8", timeout: 90000 });
  assert.ifError(run.error);
  const output = `${run.stdout}${run.stderr}`;
  writeFileSync(path.join(folder, `${mutant.name}${propertyOnly ? "-property" : ""}.log`), output);
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, "A collection failure is not a mutation kill");
  assert.ok(run.status === 1 && /not ok \d+ -|✖ /.test(output), `${mutant.name} survived`);
  results.push({ name: mutant.name, propertyOnly, killed: true });
}
try {
  for (const name of ["src", "public", "test", "migrations", "tools", "package.json"]) {cpSync(name, path.join(target, name), { recursive: true });}
  symlinkSync(path.resolve("node_modules"), path.join(target, "node_modules"));
  for (const mutant of mutants) {
    const file = path.join(target, mutant.file), original = readFileSync(file, "utf8");
    assert.equal(original.split(mutant.from).length, 2, `${mutant.name} requires a unique mutation point`);
    try {
      writeFileSync(file, original.replace(mutant.from, mutant.to));
      exercise(mutant);
      if (mutant.property) {exercise(mutant, true);}
    } finally {writeFileSync(file, original);}
    assert.equal(readFileSync(file, "utf8"), readFileSync(mutant.file, "utf8"));
  }
  const tests = [...new Set(mutants.map((mutant) => mutant.test))];
  const restored = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], { cwd: target, encoding: "utf8", timeout: 90000 });
  assert.ifError(restored.error);
  writeFileSync(path.join(folder, "restored.log"), `${restored.stdout}${restored.stderr}`);
  assert.equal(restored.status, 0, "Restored sources must pass");
} finally {
  rmSync(target, { recursive: true, force: true });
  writeFileSync(path.join(folder, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ killed: results.filter((entry) => !entry.propertyOnly).length, propertyKilled: results.filter((entry) => entry.propertyOnly).length }));
