// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const target = "src/smart-scm-po-handoff.js";
const tests = ["test/mbt/unit/smart-scm-po-to-handoff.test.js",
  "test/mbt/property/smart-scm-po-to-handoff.property.test.js"];
const mutants = [
  ["unrequested proposals cover demand", "|| !row.order_requested_at", "|| false"],
  ["real PO counted twice", "row.netsuite_purchase_order_id === null || row.netsuite_purchase_order_id === undefined", "true"],
  ["request moved to the wrong yard", "`${evidence.itemId}:${evidence.locationId}`", "`${evidence.itemId}:26`"],
  ["vendor review covers unconfirmed remainder", "? row.confirmed_pallets : row.proposed_pallets", "? row.proposed_pallets : row.proposed_pallets"],
  ["overcoverage creates negative demand", "round(Math.max(0, state.requiredPallets - requested))", "round(state.requiredPallets - requested)"],
  ["duplicate request evidence counted twice", "if (!evidence || seenLines.has(evidence.lineId))", "if (!evidence)"]
];
const original = await readFile(target, "utf8");
const root = await mkdtemp("/app/test-artifacts/po-to-mutations-");
try {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  for (const file of tests) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(file, path.join(root, file));
  }
  for (const [name, from, to] of mutants) {
    assert.equal(original.split(from).length, 2, `Unique mutation anchor: ${name}`);
    await writeFile(path.join(root, target), original.replace(from, to));
    for (const selection of [tests, [tests[1]]]) {
      const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...selection],
        { cwd: root, encoding: "utf8", timeout: 30000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, `Surviving mutation: ${name}`);
      assert.match(result.stdout, /ERR_ASSERTION|AssertionError|Property failed/);
    }
    process.stdout.write(`Killed (unit/property and property alone): ${name}\n`);
  }
  assert.equal(await readFile(target, "utf8"), original);
  process.stdout.write(`Mutations killed: ${mutants.length}/${mutants.length}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
