import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(process.env.MBT_MUTATION_EPHEMERAL, "1", "Use a disposable container without source mounts");
const backend = "src/dispatch-delivery-group-repository.js";
const frontend = "public/dispatch.js";
const repair = "tools/repair-ce94487-stale-address.mjs";
const integration = ["test/dispatch/integration/dispatch-stale-address.test.js"];
const tests = ["test/dispatch/unit/dispatch-stale-address.test.js", "test/dispatch/frontend/dispatch-stale-address.test.js"];
const mutants = [
  { name: "stale group destination survives source refresh", file: backend, from: "    ...groupedSalesOrderDeliveryFields(order, childOrderDetails),", to: "", property: true },
  { name: "manual group address lost", file: backend, from: "const address = manuallyChanged ? currentAddress : text(representative.address);", to: "const address = text(representative.address);", property: true },
  { name: "reordered group uses wrong source", file: backend, from: "children.find((child) => text(child.id).toLowerCase() === representativeRef) || children[0]", to: "children[0]" },
  { name: "PO destination incorrectly follows source member", file: backend, from: 'text(order.type).toUpperCase() !== "SO" || !children.length', to: '!children.length' },
  { name: "edit leaves routing alias stale", file: frontend, from: "        order.destinationAddress = address;", to: "" },
  { name: "empty acknowledgement ignored", file: frontend, from: 'payload.updated?.dispatch_address ?? data.address ?? ""', to: 'payload.updated?.dispatch_address || data.address || ""' },
  { name: "PO acknowledgement overwrites vendor pickup", file: frontend, from: "      if (!isPurchaseOrderDeliveryOverride) {", to: "      if (true) {" },
  { name: "repair accepts stale timing revision", file: repair, from: '  assert.equal(Number(projection.revision),Number(plan.revision),"Timing projection revision changed");', to: "", tests: integration },
  { name: "repair accepts overlapping stops", file: repair, from: '    assert.ok(stop.timing.arrival>=cursor && stop.timing.depart>=stop.timing.arrival,"Projected stop times overlap");', to: "", tests: integration },
  { name: "repair accepts changed stop identities", file: repair, from: '  assert.deepEqual(projection.stops.map(stop=>stop.id),load.stops.map(stop=>stop.id),"Projected stop identities changed");', to: "", tests: integration }
];
const originals = new Map(await Promise.all([backend, frontend, repair].map(async file => [file, await readFile(file, "utf8")])));
const hash = source => createHash("sha256").update(source).digest("hex");
function run(propertyOnly = false, files = tests) {
  const result = spawnSync(process.execPath, ["--test", ...(propertyOnly ? ["--test-name-pattern=SA-2 source projection is idempotent"] : []), ...files],
    { encoding: "utf8", timeout: 60000, env: process.env });
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
    const result = run(false, mutant.tests || tests);
    assert.notEqual(result.status, 0, `Survived: ${mutant.name}`);
    assert.match(result.output, /not ok/u);
    killed += 1;
    if (mutant.property) {
      assert.notEqual(run(true).status, 0, `Property missed: ${mutant.name}`);
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
