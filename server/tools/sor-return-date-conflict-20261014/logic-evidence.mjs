import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMutations } from "./mutations.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const task = "tools/sor-return-date-conflict-20261014";
const out = "test-artifacts/sor-return-date-conflict-20261014/logic";
mkdirSync(out, { recursive: true });
function snapshot() {
  const root = mkdtempSync("/tmp/sor-return-logic-");
  for (const folder of ["src", "public", "test"]) { cpSync(folder, root + "/" + folder, { recursive: true }); }
  for (const folder of ["node_modules", "migrations", "tools", "test-artifacts"]) { symlinkSync(resolve(folder), root + "/" + folder); }
  for (const file of ["package.json", "netsuite-smart-scm-picking-ticket-restlet.js"]) { cpSync(file, root + "/" + file); }
  return root;
}
function tests(label, files, options = {}) {
  const path = resolve(out + "/" + label + ".log"), fd = openSync(path, "w");
  let result;
  try {
    result = spawnSync(process.execPath, ["--test", "--test-concurrency=1",
      ...(options.pattern ? ["--test-name-pattern=" + options.pattern] : []), ...files],
    { cwd: options.cwd || process.cwd(), env: process.env, timeout: 120_000, stdio: ["ignore", fd, fd] });
  } finally { closeSync(fd); }
  const log = readFileSync(path, "utf8");
  return { exit: result.status, fail: Number(log.match(/^# fail (\d+)$/m)?.[1] || 0),
    failures: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]), log };
}
await runMutations({ snapshot, tests, reset: () => {}, out,
  primary: ["test/dispatch/unit/dispatch-sor-return-date-conflict.test.js"] });
const runtime = JSON.parse(readFileSync(task + "/files.json", "utf8")).runtime;
writeFileSync(out + "/source.json", JSON.stringify({
  hashes: Object.fromEntries(runtime.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])),
  propertyRuns: 100, node: process.version
}, null, 2) + "\n");
console.log("Five logic mutants and five property-only runs rejected the injected bugs.");
