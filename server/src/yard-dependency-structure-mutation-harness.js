import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("./yard-dependency-structure.js", import.meta.url);
const original = await readFile(moduleUrl, "utf8");

function replaceExact(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, `Mutation target count changed: ${from}`);
  return source.replace(from, to);
}

function importMutant(source, name) {
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// mutant: ${name}`).toString("base64")}`);
}

const mutations = [
  {
    name: "lock yard replenishment and allow direct ship",
    from: 'return mode !== "yard_replenishment";',
    to: 'return mode === "yard_replenishment";',
    async killed(candidate) {
      assert.equal(candidate.dependencyBlocksDispatchStructureChange({ mode: "yard_replenishment" }), false);
      assert.equal(candidate.dependencyBlocksDispatchStructureChange({ mode: "direct_to_customer" }), true);
    }
  },
  {
    name: "drop the split parent dependency reference",
    from: "    order.originalOrderId,\n",
    to: "",
    async killed(candidate) {
      assert.deepEqual(
        candidate.dispatchDependencyOrderRefs({ id: "SOB116330-S1", originalOrderId: "SOB116330" }),
        ["SOB116330-S1", "SOB116330"]
      );
    }
  },
  {
    name: "accept when only one split follows the TO",
    from: "  return salesAssignments.every((assignment) =>\n",
    to: "  return salesAssignments.some((assignment) =>\n",
    async killed(candidate) {
      const precedes = (transfer, sales) => transfer.sequence < sales.sequence;
      assert.equal(candidate.everySalesAssignmentFollowsTransfer(
        { sequence: 2 },
        [{ sequence: 1 }, { sequence: 3 }],
        precedes
      ), false);
    }
  }
];

let killed = 0;
const survived = [];
for (const mutation of mutations) {
  const candidate = await importMutant(replaceExact(original, mutation.from, mutation.to), mutation.name);
  try {
    await mutation.killed(candidate);
  } catch {
    killed += 1;
    continue;
  }
  survived.push(mutation.name);
}

assert.equal(killed, mutations.length,
  `Every yard-dependency structure mutant must be killed. Survived: ${survived.join(", ")}`);
console.log(`Yard-dependency structure mutation harness passed; ${killed}/${mutations.length} mutants killed.`);
