import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_MUTATION_EPHEMERAL, "1", "Mutation requires a disposable source container.");
assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const service = "src/scm-vendor-completion.js";
const repository = "src/dispatch-repository.js";
const integration = "test/dispatch/integration/scm-search-vendor-completion.test.js";
const property = "test/dispatch/property/scm-vendor-completion.property.test.js";
const mutants = [
  ["SCM authorization removed", service, "!actorId || !roles.some", "!actorId || false && !roles.some", [integration, property]],
  ["MBT accepted instead of Vendor", service, '!== "vendor"', '!== "mbt"', [integration]],
  ["stale revision accepted", service, "if (!currentRevision.rows[0]?.matches)", "if (false && !currentRevision.rows[0]?.matches)", [integration]],
  ["completion leaves schedule Queued", service, "SET status='Completed',updated_by", "SET status='Queued',updated_by", [integration]],
  ["search remains limited to active status", repository, "const searchAllStatuses = Boolean(globalSearch)", "const searchAllStatuses = false && Boolean(globalSearch)", [integration]]
];
let killed = 0;
for (const [name, file, from, to, tests] of mutants) {
  const original = await readFile(file, "utf8");
  assert.equal(original.split(from).length, 2, `Unique mutation target required: ${name}`);
  try {
    await writeFile(file, original.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `SURVIVED: ${name}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /not ok|✖/u, `The mutant must fail an assertion: ${name}`);
    if (name === "SCM authorization removed") {
      const properties = spawnSync(process.execPath, ["--test", property], { encoding: "utf8" });
      assert.notEqual(properties.status, 0, "The authorization property must independently reject its mutant.");
    }
    killed += 1;
    console.log(`KILLED: ${name}`);
  } finally {
    await writeFile(file, original);
    assert.equal(await readFile(file, "utf8"), original);
  }
}
console.log(`Manual mutation: ${killed}/${mutants.length} killed; authorization property independently killed its mutant.`);
