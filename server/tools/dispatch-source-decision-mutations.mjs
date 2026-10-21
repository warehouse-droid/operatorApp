import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isolatedRun } from "./dispatch-source-decision-checks.mjs";

const root = "/tmp/dispatch-source-decision-mutants";
const mutations = [
  { name: "reverse-driver-start-cutoff", file: "src/dispatch-executed-order-review.js",
    before: "received < started", after: "received > started", test: "test/dispatch/unit/dispatch-source-decision.test.js" },
  { name: "protect-actually-overwrites-source", file: "src/dispatch-executed-order-review-repository.js",
    before: 'pending.length && decision === "accept_netsuite_change"', after: "pending.length", test: "test/dispatch/integration/dispatch-source-decision.test.js" },
  { name: "old-receipt-approves-later-edit", file: "src/dispatch-executed-order-review.js",
    before: "return same(rows(source.items || []), rows(payload.lines));", after: "return true;", test: "test/dispatch/unit/dispatch-source-decision.test.js" },
  { name: "automatic-acceptance-silently-acknowledges", file: "src/dispatch-executed-order-review-repository.js",
    before: "acknowledged_at=NULL,actor_id=NULL", after: "acknowledged_at=now(),actor_id=NULL", test: "test/dispatch/integration/dispatch-source-decision.test.js" },
  { name: "lose-group-cargo-totals", file: "src/dispatch-executed-order-review.js",
    before: "result[field] = children.reduce((sum, child) => sum + Number(child[field] || 0), 0);", after: "result[field] = 0;", test: "test/dispatch/unit/dispatch-source-decision.test.js" },
  { name: "browser-drops-dispatch-choice", file: "public/dispatch.js",
    before: "...(decision ? { decision, baseRevision: currentPlan.revision } : {})", after: "...{}",
    test: "test/dispatch/frontend/dispatch-source-decision.browser.test.mjs" }
];
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const results = [];
try {
  for (const mutation of mutations) {
    const candidate = `${root}/${mutation.name}`;
    mkdirSync(candidate);
    for (const dir of ["src", "public", "test", "migrations", "contracts"]) {cpSync(dir, `${candidate}/${dir}`, { recursive: true });}
    cpSync("package.json", `${candidate}/package.json`);
    symlinkSync("/app/node_modules", `${candidate}/node_modules`);
    const path = `${candidate}/${mutation.file}`;
    const original = readFileSync(path, "utf8");
    assert.equal(original.split(mutation.before).length, 2, mutation.name);
    writeFileSync(path, original.replace(mutation.before, mutation.after));
    const result = await isolatedRun(mutation.test, { cwd: candidate, prefix: `mutation-${mutation.name}` });
    assert.notEqual(result.exit, 0, `Surviving mutant ${mutation.name}`);
    assert.ok(result.failures.length, `Mutant did not fail a behavioral assertion: ${mutation.name}`);
    results.push({ name: mutation.name, killed: true, failures: result.failures });
    console.log(JSON.stringify(results.at(-1)));
    rmSync(candidate, { recursive: true, force: true });
  }
} finally {rmSync(root, { recursive: true, force: true });}
writeFileSync("test-artifacts/source-decision/mutations.json", JSON.stringify(results, null, 2));
