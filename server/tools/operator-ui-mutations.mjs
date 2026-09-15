import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Mutations require the disposable test database");
const root = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), "operator-ui-mutations-"));
const tests = ["test/mbt/unit/operator-ui-enhancements.test.js", "test/mbt/integration/operator-ui-enhancements.test.js"];
const mutations = [
  { name: "absolute physical quantities add again", file: "src/delivery-repository.js", from: "(absolute ? 0 : positiveQuantity(line.packed_piece_qty)) + pieces", to: "positiveQuantity(line.packed_piece_qty) + pieces", property: true },
  { name: "zero cannot clear an absolute confirmation", file: "src/delivery-repository.js", from: "if (!absolute && (next.pallets + next.layers + next.pieces + next.sections + packedSalesQty) <= 0)", to: "if ((next.pallets + next.layers + next.pieces + next.sections + packedSalesQty) <= 0)", property: true },
  { name: "unknown quantity modes are accepted", file: "src/delivery-repository.js", from: 'if (mode !== "additive" && mode !== "absolute")', to: "if (false)", property: false },
  { name: "pickup shows remaining in the confirmed editor", file: "public/operator.js", from: "if (isCustomerPickupMode()) return hasPackedQty(line) ? packedValue(line, unit) : remainingValue(line, unit);", to: "if (isCustomerPickupMode()) return remainingValue(line, unit);", property: true },
  { name: "legacy callers silently switch to absolute", file: "src/delivery-repository.js", from: 'values?.quantityMode === undefined ? "additive" : values.quantityMode', to: 'values?.quantityMode === undefined ? "absolute" : values.quantityMode', property: false }
];

function run(property = false) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(property ? ["--test-name-pattern=quantities"] : []), ...tests], {
    cwd: temporary, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_V8_COVERAGE: "" }
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

try {
  for (const directory of ["src", "public"]) {
    await cp(path.join(root, directory), path.join(temporary, directory), { recursive: true });
  }
  await cp(path.join(root, "package.json"), path.join(temporary, "package.json"));
  await symlink(path.join(root, "node_modules"), path.join(temporary, "node_modules"));
  for (const file of [...tests, "test/support/operator-ui-enhancements-fixture.mjs"]) {
    await mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await cp(path.join(root, file), path.join(temporary, file));
  }
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.output);
  let propertyKilled = 0;
  for (const mutation of mutations) {
    const file = path.join(temporary, mutation.file);
    const original = await readFile(file, "utf8");
    assert.equal(original.split(mutation.from).length, 2, `Mutation must be unique: ${mutation.name}`);
    await writeFile(file, original.replace(mutation.from, mutation.to));
    try {
      const result = run();
      assert.notEqual(result.status, 0, `Survived: ${mutation.name}`);
      assert.match(result.output, /not ok/u);
      if (mutation.property) {
        const properties = run(true);
        assert.notEqual(properties.status, 0, `Properties missed: ${mutation.name}`);
        assert.match(properties.output, /not ok/u);
        propertyKilled += 1;
      }
      console.log(`KILLED ${mutation.name}`);
    } finally {
      await writeFile(file, original);
    }
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.output);
  console.log(JSON.stringify({ killed: mutations.length, total: mutations.length, propertyKilled, restored: true }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
