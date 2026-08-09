import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryPath = path.join(serverRoot, "src/scm-reconciliation-repository.js");
const serverPath = path.join(serverRoot, "src/server.js");
const originals = new Map([
  [repositoryPath, await readFile(repositoryPath, "utf8")],
  [serverPath, await readFile(serverPath, "utf8")]
]);

function replaceExact(source, from, to, expectedCount = 1) {
  const count = source.split(from).length - 1;
  assert.equal(count, expectedCount, `Mutation target count changed for: ${from}`);
  return source.replaceAll(from, to);
}

function replaceOccurrence(source, from, to, occurrence, expectedCount) {
  const count = source.split(from).length - 1;
  assert.equal(count, expectedCount, `Mutation target count changed for: ${from}`);
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = source.indexOf(from, offset + 1);
  }
  assert(offset >= 0, `Mutation occurrence ${occurrence} is missing for: ${from}`);
  return `${source.slice(0, offset)}${to}${source.slice(offset + from.length)}`;
}

const mutations = [
  {
    name: "allow a newer manual status to reopen Completed",
    file: repositoryPath,
    test: "src/scm-reconciliation-repository-harness.js",
    expectedFailure: /completed reconciliation outcome must remain terminal/i,
    mutate(source) {
      return replaceExact(
        source,
        'if (["complete", "completed"].includes(currentReconciliationApplicationStatus.toLowerCase())) {\n    return "Completed";\n  }',
        'if (false && ["complete", "completed"].includes(currentReconciliationApplicationStatus.toLowerCase())) {\n    return "Completed";\n  }'
      );
    }
  },
  {
    name: "drop schedule identity and timestamp before Dispatch reconciliation enrichment",
    file: serverPath,
    test: "src/scm-order-visibility-integration-harness.js",
    expectedFailure: /did not return eligible control row .*manual-queued-stale-hold/i,
    mutate(source) {
      return replaceExact(
        source,
        'status: order.scm?.status || "Queued",\n        scheduleId: order.scm?.scheduleId || null,\n        updatedAt: order.scm?.updatedAt || null',
        'status: order.scm?.status || "Queued"'
      );
    }
  },
  {
    name: "invert the target-level newer-manual-schedule comparison",
    file: serverPath,
    test: "src/scm-order-visibility-integration-harness.js",
    expectedFailure: /did not return eligible control row .*manual-queued-stale-hold/i,
    mutate(source) {
      return replaceOccurrence(
        source,
        "manual_schedule.updated_at > state.reconciled_at",
        "manual_schedule.updated_at < state.reconciled_at",
        1,
        2
      );
    }
  }
];

let killed = 0;
try {
  for (const mutation of mutations) {
    const original = originals.get(mutation.file);
    await writeFile(mutation.file, mutation.mutate(original));
    const result = spawnSync(process.execPath, [mutation.test], {
      cwd: serverRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240_000
    });
    await writeFile(mutation.file, original);
    if (result.error) throw result.error;
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.notEqual(result.status, 0, `Mutation survived: ${mutation.name}`);
    assert.match(output, mutation.expectedFailure,
      `Mutation failed for an unrelated reason: ${mutation.name}\n${output}`);
    killed += 1;
    console.log(`[mutation] killed: ${mutation.name}`);
  }
} finally {
  await Promise.all([...originals].map(([file, source]) => writeFile(file, source)));
}

assert.equal(killed, mutations.length, "Every SCM status-precedence mutant must be killed.");
console.log(`SCM status precedence mutation harness passed: ${killed}/${mutations.length} mutants killed.`);
