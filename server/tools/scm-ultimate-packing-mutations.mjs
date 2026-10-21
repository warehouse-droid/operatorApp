import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = "test-artifacts/scm-ultimate-packing-20261005/final/mutations";
mkdirSync(directory, { recursive: true });
const planner = "src/smart-scm-planning-repository.js";
const partial = "const partialUltimate = remainders.filter((load) => !operationallyFullLoad(load, truckCapacity));";
const mutations = [
  ["Discard hard urgency packing", planner,
    "return ultimatePriorityProposalLoads(baselineLoads, truckCapacity, maxStops);", "return baselineLoads;"],
  ["Split fitting urgent destinations across multiple routes", planner,
    "const destinationLoads = packProposalUnits(ultimate, truckCapacity, 1);",
    "const destinationLoads = packProposalUnits(ultimate, truckCapacity, maxStops);"],
  ["Allow normal filler in full urgent loads", planner, partial,
    "const partialUltimate = [...fullUltimate, ...remainders.filter((load) => !operationallyFullLoad(load, truckCapacity))]; fullUltimate.length = 0;"],
  ["Merge whole urgent groups beyond truck capacity", planner,
    "load.totalWeight + partial.totalWeight <= truckCapacity + EPSILON",
    "load.totalWeight + partial.totalWeight <= truckCapacity * 2 + EPSILON"],
  ["Keep compatible partial urgent groups unnecessarily separate", planner,
    "function wholeUrgentRemainderLoads(partials = [], truckCapacity = 0, maxStops = 2) {",
    "function wholeUrgentRemainderLoads(partials = [], truckCapacity = 0, maxStops = 2) { return partials;"],
  ["Remove full urgent display priority", "public/scm-smart-proposals.js",
    "|| smartProposalUltimateLoadPriority(left) - smartProposalUltimateLoadPriority(right)", "|| 0"],
  ["Ignore physical pallet weight", planner,
    "return round(materialWeight + (pallets * physicalPalletUnitWeight(line, physicalPalletWeightLbs)));", "return round(materialWeight);"],
  ["Lose partial vendor hub routing", planner,
    "if (!directDestinationIds.size || !hub || directDestinationIds.has(hubLocationId)) {",
    "if (true || !directDestinationIds.size || !hub || directDestinationIds.has(hubLocationId)) {"],
  ["Lose merged destination allocations", planner,
    "const destinationAllocations = tracksMultipleDestinations\n    ? mergedLineDestinationAllocations(existing, next)\n    : null;", "const destinationAllocations = null;"],
  ["Accept zero-capacity trucks", planner,
    'if (truckCapacity <= EPSILON) throw new Error("Truck capacity must be greater than zero.");',
    'if (truckCapacity < 0) throw new Error("Truck capacity must be greater than zero.");']
];
const unit = "test/mbt/unit/scm-ultimate-packing.test.js";
const property = "test/mbt/property/scm-ultimate-packing.property.test.js";
const reports = [];
for (const [index, [name, file, original, replacement]] of mutations.entries()) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "scm-ultimate-mutant-"));
  try {
    for (const folder of ["src", "public"]) cpSync(folder, path.join(sandbox, folder), { recursive: true });
    cpSync("package.json", path.join(sandbox, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(sandbox, "node_modules"), "dir");
    symlinkSync(path.resolve("test-artifacts"), path.join(sandbox, "test-artifacts"), "dir");
    for (const testFile of [unit, property]) {
      mkdirSync(path.dirname(path.join(sandbox, testFile)), { recursive: true });
      cpSync(testFile, path.join(sandbox, testFile));
    }
    const target = path.join(sandbox, file), source = readFileSync(target, "utf8");
    assert.equal(source.split(original).length, 2, `Mutation anchor changed: ${name}`);
    writeFileSync(target, source.replace(original, replacement));
    const stages = [];
    for (const [stage, testFile] of [["focused", unit], ["properties-only", property]]) {
      const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", testFile],
        { cwd: sandbox, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" }, timeout: 60000 });
      const output = `${run.stdout || ""}${run.stderr || ""}`;
      writeFileSync(`${directory}/${index + 1}-${stage}.log`, output);
      const killed = run.status !== 0 && /ERR_ASSERTION|Property failed after/.test(output)
        && !/ERR_MODULE_NOT_FOUND|SyntaxError/.test(output);
      stages.push({ stage, killed, exitCode: run.status });
      assert.ok(killed, `Mutant survived or failed for a non-behavioral reason: ${name} (${stage})`);
    }
    reports.push({ name, file, stages });
    console.log(JSON.stringify({ name, stages }));
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}
writeFileSync(`${directory}/summary.json`, `${JSON.stringify(reports, null, 2)}\n`);
console.log(JSON.stringify({ mutants: reports.length, focusedKilled: reports.length, propertiesOnlyKilled: reports.length }));
