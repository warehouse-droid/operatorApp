import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const supportDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(supportDirectory, "../..");

if (process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch active-load mutations require a disposable writable test container.");
}

const mutants = [
  {
    name: "does not atomically shift the active-load finish",
    file: "src/dispatch-load-assignment.js",
    before: "const offset = baselineStart - candidateStart;",
    after: "const offset = 0;",
    command: ["src/dispatch-load-assignment-harness.js"]
  },
  {
    name: "lets a fully completed load drift as a forecastable prefix",
    file: "src/dispatch-load-assignment.js",
    before: "&& activityBoundary < ((load.stops || []).length - 1)",
    after: "&& true",
    command: ["src/dispatch-load-assignment-harness.js"]
  },
  {
    name: "drops nested compact child-order evidence",
    file: "public/dispatch.js",
    before: "  const evidenceOrder = assignedOrderEvidenceById.get(orderId);\n  if (evidenceOrder) return evidenceOrder;\n",
    after: "",
    command: ["--test", "test/dispatch/frontend/dispatch-planner-performance.contract.test.js"]
  },
  {
    name: "rewrites an active grouped child stop to its parent",
    file: "public/dispatch.js",
    before: "        if (stopHasDriverActivity(load, stop)) {\n          nextStops.push(stop);\n          if (stop.type === \"drop\") seenDropGroups.add(group.id);\n          continue;\n        }",
    after: "        if (false) {\n          nextStops.push(stop);\n          if (stop.type === \"drop\") seenDropGroups.add(group.id);\n          continue;\n        }",
    command: ["--test", "test/dispatch/frontend/dispatch-planner-performance.contract.test.js"]
  },
  {
    name: "leaves a newly appended load overlapping the restored completed prefix",
    file: "src/dispatch-load-assignment.js",
    before: "  return rebaseMutableLaneSuffixes(overlaidPlan, restoredLoadIds, locked);",
    after: "  return overlaidPlan;",
    command: ["src/dispatch-load-assignment-harness.js"]
  },
  {
    name: "keeps planner undo as a browser-only history change",
    file: "public/dispatch.js",
    before: "  commitPlanMutation(\"dispatch_plan_undo\", null, { forceSave: true });",
    after: "  commitPlanMutation(\"dispatch_plan_undo\");",
    command: ["--test", "test/dispatch/frontend/dispatch-planner-performance.contract.test.js"]
  },
  {
    name: "keeps planner redo as a browser-only history change",
    file: "public/dispatch.js",
    before: "  commitPlanMutation(\"dispatch_plan_redo\", null, { forceSave: true });",
    after: "  commitPlanMutation(\"dispatch_plan_redo\");",
    command: ["--test", "test/dispatch/frontend/dispatch-planner-performance.contract.test.js"]
  },
  {
    name: "allows deletion or resequencing of loads before active Driver work",
    file: "src/dispatch-planner-performance.js",
    before: "    if (lanePrefixChanged || priorLoadChanges.length || boundaryMetadataChanged) {",
    after: "    if (false) {",
    command: ["--test", "test/mbt/unit/driver-live-route-prefix-lock.red.test.js"]
  },
  {
    name: "lets billed reconciliation delete completed Driver route evidence",
    file: "src/dispatch-plan-repository.js",
    before: "      if (!executionPolicy.allowed) {",
    after: "      if (false) {",
    command: ["--test", "test/mbt/integration/driver-live-route-prefix-lock.integration.test.js"]
  },
  {
    name: "ignores durable in-progress Driver work when choosing the cursor",
    file: "src/driver-route-cursor.js",
    before: "  if (activeById.size) {",
    after: "  if (false) {",
    command: ["--test", "test/mbt/unit/driver-live-route-prefix-lock.red.test.js"]
  },
  {
    name: "lets the cursor return to pending work before completed progress",
    file: "src/driver-route-cursor.js",
    before: "  for (let candidate = latestCompletedIndex + 1; candidate < orderedJobs.length; candidate += 1) {",
    after: "  for (let candidate = 0; candidate < orderedJobs.length; candidate += 1) {",
    command: ["--test", "test/mbt/unit/driver-live-route-prefix-lock.red.test.js"]
  },
  {
    name: "lets the offline PWA fall back to the first pending route gap",
    file: "public/driver.js",
    before: "  const nextPending = jobs.find((job, index) => index > latestCompletedIndex && !jobIsComplete(job));",
    after: "  const nextPending = jobs.find((job) => !jobIsComplete(job));",
    command: ["--test", "test/mbt/unit/driver-offline-route-cursor.red.test.js"]
  }
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const originals = new Map();
for (const file of [...new Set(mutants.map((mutant) => mutant.file))]) {
  originals.set(file, await readFile(path.join(serverRoot, file), "utf8"));
}

let killed = 0;
try {
  for (const mutant of mutants) {
    const target = path.join(serverRoot, mutant.file);
    const original = originals.get(mutant.file);
    assert.equal(
      original.split(mutant.before).length - 1,
      1,
      `Mutation anchor must occur exactly once: ${mutant.name}`
    );
    await writeFile(target, original.replace(mutant.before, mutant.after));
    const result = spawnSync(process.execPath, mutant.command, {
      cwd: serverRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" }
    });
    await writeFile(target, original);
    if (result.status === 0) {
      throw new Error(`Surviving dispatch active-load mutant: ${mutant.name}\n${result.stdout}\n${result.stderr}`);
    }
    killed += 1;
    console.log(`[mutation] killed: ${mutant.name}`);
  }
} finally {
  for (const [file, original] of originals) {
    await writeFile(path.join(serverRoot, file), original);
  }
}

for (const [file, original] of originals) {
  const restored = await readFile(path.join(serverRoot, file), "utf8");
  assert.equal(sha256(restored), sha256(original), `Source restoration hash mismatch: ${file}`);
}

assert.equal(killed, mutants.length);
console.log(`${killed}/${mutants.length} dispatch active-load mutants killed.`);
