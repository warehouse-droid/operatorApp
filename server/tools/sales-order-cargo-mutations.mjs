import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(process.env.MBT_MUTATION_EPHEMERAL, "1", "Use a disposable container without host source mounts");
const tests = ["test/dispatch/unit/sales-order-cargo-integrity.red.test.js", "test/dispatch/frontend/sales-order-group-hydration.red.test.js"];
const mutants = [
  { name: "single SO reader drops fulfilled lines", file: "src/netsuite.js", from: "    ORDER BY tl.uniquekey\n  `;\n\n  const result = await suiteql(detailQuery);",
    to: "      AND ${openLineFilterSql(\"tl\")}\n    ORDER BY tl.uniquekey\n  `;\n\n  const result = await suiteql(detailQuery);", property: true },
  { name: "batch SO reader drops fulfilled lines", file: "src/netsuite.js", from: "      ORDER BY tl.transaction, tl.uniquekey\n    `);", to: "        AND ${openLineFilterSql(\"tl\")}\n      ORDER BY tl.transaction, tl.uniquekey\n    `);" },
  { name: "subtract fulfilled quantity from ordered cargo", file: "src/netsuite.js", from: "return deriveQuantitiesFromSalesQuantity(line, orderedQuantity);", to: "return deriveQuantitiesFromSalesQuantity(line, Math.max(0, orderedQuantity - toNumber(line.netsuite_received_qty)));", property: true },
  { name: "compact card loses item ID", file: "src/dispatch-planner-optimization.js", from: '"id", "itemId", "lineRowId", "lineId",', to: '"id", "lineRowId", "lineId",' },
  { name: "legacy ID enrichment ignored", file: "src/dispatch-allocation-item-identity.js", from: "if (ids?.size === 1) item.itemId = [...ids][0];", to: "if (false) item.itemId = [...ids][0];", property: true },
  { name: "ambiguous SKU accepted", file: "src/dispatch-allocation-item-identity.js", from: "if (ids?.size === 1)", to: "if (ids?.size >= 1)" },
  { name: "only first selected order hydrated", file: "public/dispatch.js", from: "Promise.all(selected.filter(dispatchGroupOrderNeedsHydration)", to: "Promise.all(selected.slice(0, 1).filter(dispatchGroupOrderNeedsHydration)" },
  { name: "direct CO source details block owned cargo", file: "public/dispatch.js", from: '  if (canonicalDispatchOrderType(order.type, order.id) === "CO" && !isAggregateDispatchCoGroup(order)) return false;\n', to: "" },
  { name: "selection race ignored", file: "public/dispatch.js", from: "JSON.stringify(current.map((order) => order.id).sort()) !== JSON.stringify(ids)", to: "false" }
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const originals = new Map(await Promise.all([...new Set(mutants.map((mutant) => mutant.file))].map(async (file) => [file, await readFile(file, "utf8")])));
function run(propertyOnly = false) {
  const args = ["--test", ...(propertyOnly ? ["--test-name-pattern=SO-01 ordered quantity|ID-02 enrichment is symmetric"] : []), ...tests];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, env: process.env });
  if (result.error) { throw result.error; }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
assert.equal(run().status, 0, "Mutation baseline must pass");
let killed = 0;
let propertyKilled = 0;
try {
  for (const mutant of mutants) {
    const source = originals.get(mutant.file);
    assert.equal(source.split(mutant.from).length, 2, `Mutant must be unique: ${mutant.name}`);
    await writeFile(mutant.file, source.replace(mutant.from, mutant.to));
    const result = run();
    assert.notEqual(result.status, 0, `Survived: ${mutant.name}`);
    assert.match(result.output, /not ok/u);
    killed += 1;
    if (mutant.property) {
      assert.notEqual(run(true).status, 0, `Properties missed: ${mutant.name}`);
      propertyKilled += 1;
    }
    console.log(`KILLED ${mutant.name}`);
    await writeFile(mutant.file, source);
  }
} finally {
  for (const [file, source] of originals) {
    await writeFile(file, source);
    assert.equal(hash(await readFile(file)), hash(source));
  }
}
assert.equal(run().status, 0, "Restored source must pass");
console.log(JSON.stringify({ killed, total: mutants.length, propertyKilled, restored: true }));
