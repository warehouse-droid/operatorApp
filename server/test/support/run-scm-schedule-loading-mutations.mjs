#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

if (process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("SCM schedule loading mutation runner requires MBT_MUTATION_EPHEMERAL=1.");
}

const repositoryUrl = new URL("../../src/dispatch-repository.js", import.meta.url);
const projectionUrl = new URL("../../src/dispatch-planner-v2-repository.js", import.meta.url);
const testFiles = [
  "test/dispatch/integration/scm-schedule-loading-performance.red.test.js",
  "test/dispatch/integration/scm-po-split-schedule-remaining.test.js",
  "src/netsuite-closed-order-repository-harness.js"
];
const originals = new Map([
  [repositoryUrl, await readFile(repositoryUrl, "utf8")],
  [projectionUrl, await readFile(projectionUrl, "utf8")]
]);

const mutants = [
  {
    name: "Completed status no longer opts in",
    file: repositoryUrl,
    from: `const includeCompleted = cleanView === "completed"
    || statusFilters.some((value) => value.toLowerCase() === "completed");`,
    to: `const includeCompleted = cleanView === "completed"
    && statusFilters.some((value) => value.toLowerCase() === "completed");`
  },
  {
    name: "cancelled plans become the only planned source",
    file: repositoryUrl,
    from: `JOIN dispatch_plans p
          ON p.id = assignment.plan_id
         AND p.status <> 'cancelled'
       WHERE upper(assignment.assignment->>'dispatchOrderKind') IN ('PO', 'TO', 'VRMA')`,
    to: `JOIN dispatch_plans p
          ON p.id = assignment.plan_id
         AND p.status = 'cancelled'
       WHERE upper(assignment.assignment->>'dispatchOrderKind') IN ('PO', 'TO', 'VRMA')`
  },
  {
    name: "default load admits Completed rows",
    file: repositoryUrl,
    from: `OR LOWER(BTRIM(effective_status.status)) NOT IN ('complete', 'completed')`,
    to: "OR TRUE"
  },
  {
    name: "closed PO families never match positive order IDs",
    file: repositoryUrl,
    from: "WHERE closed_family.netsuite_id = po.netsuite_id",
    to: "WHERE closed_family.netsuite_id = -po.netsuite_id"
  },
  {
    name: "fully split source POs remain visible",
    file: repositoryUrl,
    from: `      HAVING $24::boolean
          OR COUNT(l.id) = 0
          OR COALESCE(SUM(`,
    to: `      HAVING true
          OR COUNT(l.id) = 0
          OR COALESCE(SUM(`
  },
  {
    name: "line-less open source POs are hidden as if fully allocated",
    file: repositoryUrl,
    from: `      HAVING $24::boolean
          OR COUNT(l.id) = 0
          OR COALESCE(SUM(`,
    to: `      HAVING $24::boolean
          OR COUNT(l.id) < 0
          OR COALESCE(SUM(`
  },
  {
    name: "projected ETA hour uses the wrong divisor",
    file: projectionUrl,
    from: "Math.floor(minute / 60)",
    to: "Math.floor(minute / 600)"
  }
];

function replaceExactlyOnce(source, from, to, name) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${name}: expected one mutation target, found ${occurrences}.`);
  }
  return source.replace(from, to);
}

function runFocusedSuite() {
  return spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...testFiles
  ], {
    cwd: new URL("../..", import.meta.url),
    env: process.env,
    encoding: "utf8",
    timeout: 120_000
  });
}

let killed = 0;
try {
  for (const mutant of mutants) {
    const original = originals.get(mutant.file);
    await writeFile(mutant.file, replaceExactlyOnce(original, mutant.from, mutant.to, mutant.name));
    const result = runFocusedSuite();
    await writeFile(mutant.file, original);
    if (result.status === 0) {
      throw new Error(`SURVIVED: ${mutant.name}`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${mutants.length}: ${mutant.name}`);
  }
} finally {
  for (const [file, source] of originals) {
    await writeFile(file, source);
  }
}

const final = runFocusedSuite();
if (final.status !== 0) {
  process.stderr.write(final.stdout || "");
  process.stderr.write(final.stderr || "");
  throw new Error("Focused suite failed after mutation sources were restored.");
}
console.log(`SCM schedule loading mutation score: ${killed}/${mutants.length} killed.`);
