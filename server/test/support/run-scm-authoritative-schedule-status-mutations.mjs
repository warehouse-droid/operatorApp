// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/scm-authoritative-schedule-status.red.test.js",
  "test/mbt/unit/scm-schedule-status-refresh.red.test.js",
  "test/mbt/unit/netsuite-delayed-status-refresh-policy.red.test.js",
  "test/mbt/unit/netsuite-delayed-status-refresh-service.red.test.js",
  "test/mbt/integration/scm-schedule-status-refresh-repository.red.test.js",
  "test/mbt/integration/scm-authoritative-schedule-status.red.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "VRMA source table no longer overrides the plan PO type",
    target: "src/driver-repository.js",
    from: "  if (sourceTable === \"scm_vrma_orders\") return \"VRMA\";",
    to: "  if (false && sourceTable === \"scm_vrma_orders\") return \"VRMA\";"
  },
  {
    name: "Rejected is no longer terminal",
    target: "src/scm-reconciliation.js",
    from: "    closed: rejected\n      || String(statusCode || \"\").trim().toUpperCase() === \"H\"",
    to: "    closed: false && rejected\n      || String(statusCode || \"\").trim().toUpperCase() === \"H\""
  },
  {
    name: "Transfer Order delayed refresh support is removed",
    target: "src/netsuite-delayed-status-refresh-policy.js",
    from: "const SUPPORTED_ORDER_TYPES = new Set([\"sales_order\", \"purchase_order\", \"transfer_order\"]);",
    to: "const SUPPORTED_ORDER_TYPES = new Set([\"sales_order\", \"purchase_order\"]);"
  },
  {
    name: "Transfer Order refresh uses the Purchase Order NetSuite type",
    target: "src/netsuite-delayed-status-refresh-service.js",
    from: "      transfer_order: \"TrnfrOrd\"",
    to: "      transfer_order: \"PurchOrd\""
  },
  {
    name: "bounded refresh grows beyond ten families",
    target: "src/scm-schedule-status-refresh.js",
    from: "export const SCM_SCHEDULE_STATUS_REFRESH_BATCH_SIZE = 10;",
    to: "export const SCM_SCHEDULE_STATUS_REFRESH_BATCH_SIZE = 11;"
  },
  {
    name: "mixed PO and TO candidates enter one run",
    target: "src/scm-schedule-status-refresh.js",
    from: "    .filter((candidate) => candidate.orderKind === selectedKind)\n    .slice(0, boundedLimit);",
    to: "    .filter(() => true)\n    .slice(0, boundedLimit);"
  },
  {
    name: "initial reconciliation approval is bypassed",
    target: "src/scm-schedule-status-refresh.js",
    from: "      if (!settings?.initialDryRunApprovedAt) {",
    to: "      if (false) {"
  },
  {
    name: "operational synchronization no longer blocks refresh",
    target: "src/scm-schedule-status-refresh.js",
    from: "      if (await operationalSyncRunning()) {",
    to: "      if (false) {"
  },
  {
    name: "active reconciliation no longer blocks refresh",
    target: "src/scm-schedule-status-refresh.js",
    from: "      if (await hasActiveReconciliation()) {",
    to: "      if (false) {"
  },
  {
    name: "scheduled repair becomes a broad reconciliation",
    target: "src/scm-schedule-status-refresh.js",
    from: "        scope: \"order_family\",",
    to: "        scope: \"all\","
  },
  {
    name: "Driver-completed schedules re-enter the stale candidate queue",
    target: "src/scm-schedule-status-refresh-repository.js",
    from: "          AND completion.completion_event_id IS NULL",
    to: "          AND (completion.completion_event_id IS NULL OR true)"
  },
  {
    name: "projected partial statuses waste refresh capacity",
    target: "src/scm-schedule-status-refresh-repository.js",
    from: "            OR state.application_status IN ('Queued', 'Planned')",
    to: "            OR state.application_status IS NOT NULL"
  },
  {
    name: "local-only negative Purchase Orders enter authoritative refresh",
    target: "src/scm-schedule-status-refresh-repository.js",
    from: "                  AND purchase.netsuite_id > 0",
    to: "                  AND purchase.netsuite_id <> 0"
  },
  {
    name: "split PO refresh keeps the child alias instead of the canonical source",
    target: "src/scm-schedule-status-refresh-repository.js",
    from: "                      split.source_po_ref,",
    to: "                      split.split_po_ref,"
  },
  {
    name: "active schedule groups are not expanded to authoritative members",
    target: "src/scm-schedule-status-refresh-repository.js",
    from: "           ON group_header.status = 'active'",
    to: "           ON group_header.status = 'cancelled'"
  },
  {
    name: "historical VRMA backfill is mislabeled PO",
    target: "migrations/183_scm_authoritative_schedule_status.sql",
    from: "SELECT 'VRMA', vrma.vrma_ref, record.completed_at,",
    to: "SELECT 'PO', vrma.vrma_ref, record.completed_at,"
  }
]);

/** @param {string} value */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[SCM authoritative status mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...TESTS
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("SCM authoritative status mutations require the writable disposable mutation container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, hash(source));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (hash(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`SCM authoritative status mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
