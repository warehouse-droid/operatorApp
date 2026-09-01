// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UI_TEST = "test/dispatch/frontend/scm-manual-split-authority-ui.red.test.js";
const INTEGRATION_TEST = "test/dispatch/integration/scm-manual-split-authority.red.test.js";
const CATALOG_TEST = "test/dispatch/integration/scm-po-split-status-consistency.red.test.js";
const ALL_TESTS = Object.freeze([UI_TEST, INTEGRATION_TEST, CATALOG_TEST]);

/** @type {ReadonlyArray<{
 * name: string,
 * target: string,
 * from: string,
 * to: string,
 * occurrences?: number,
 * tests?: readonly string[]
 * }>} */
const MUTANTS = Object.freeze([
  {
    name: "the split modal defaults back to Queue",
    target: "public/dispatch-scm.js",
    from: 'let scmSplitInitialStatus = "Hold";',
    to: 'let scmSplitInitialStatus = "Queued";',
    tests: [UI_TEST]
  },
  {
    name: "a confirmed split destination is labelled as NetSuite",
    target: "public/dispatch-scm.js",
    from: 'const destinationSource = isSplit ? "Split confirmation" : "NetSuite";',
    to: 'const destinationSource = "NetSuite";',
    tests: [UI_TEST]
  },
  {
    name: "PO/TO Schedule labels a confirmed split destination as NetSuite",
    target: "public/scm-schedule.js",
    from: '  const destinationSource = isSplit ? "Split confirmation" : "NetSuite";',
    to: '  const destinationSource = "NetSuite";',
    tests: [UI_TEST]
  },
  {
    name: "PO/TO Schedule drops the split-confirmed marker from the selected destination",
    target: "public/scm-schedule.js",
    from: '  const selectedOptionLabel = (option) => `${scmScheduleEscape(option)}${isSplit ? " (Split confirmation)" : ""}`;',
    to: '  const selectedOptionLabel = (option) => scmScheduleEscape(option);',
    tests: [UI_TEST]
  },
  {
    name: "PO response projection drops split identity",
    target: "src/server.js",
    from: "isScmSplit: order.isScmSplit === true",
    to: "isScmSplit: false",
    occurrences: 2,
    tests: [UI_TEST]
  },
  {
    name: "repository split creation defaults back to Queue",
    target: "src/dispatch-repository.js",
    from: '  status = "Hold",\n  remarkOverride = "",\n  lines = [],',
    to: '  status = "Queued",\n  remarkOverride = "",\n  lines = [],',
    tests: [INTEGRATION_TEST]
  },
  {
    name: "PO/TO Schedule projects a parent review over a held manual split",
    target: "src/dispatch-repository.js",
    from: `        WHEN b.order_kind = 'PO'
          AND NULLIF(BTRIM(b.split_ref), '') IS NOT NULL
          AND lower(BTRIM(COALESCE(operational_status.status, ''))) IN (`,
    to: `        WHEN false
          AND NULLIF(BTRIM(b.split_ref), '') IS NOT NULL
          AND lower(BTRIM(COALESCE(operational_status.status, ''))) IN (`,
    tests: [INTEGRATION_TEST]
  },
  {
    name: "split creation omits the confirmed schedule destination",
    target: "src/dispatch-repository.js",
    from: "'PO', $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $1,",
    to: "'PO', $1, NULLIF($2, ''), NULL, NULLIF($4, ''), $1,",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "an unconstrained manual status is written into the constrained child mirror",
    target: "src/dispatch-repository.js",
    from: "          splitInitialMirrorStatus\n        ]",
    to: "          splitInitialStatus\n        ]",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "no manual split status is treated as operator-authoritative",
    target: "src/scm-manual-split-authority.js",
    from: "  return OPERATOR_CONTROLLED_STATUSES.has(String(status || \"\").trim().toLowerCase());",
    to: "  return false;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "Planned is incorrectly treated as operator-authoritative",
    target: "src/scm-manual-split-authority.js",
    from: "  return OPERATOR_CONTROLLED_STATUSES.has(String(status || \"\").trim().toLowerCase());",
    to: "  return true;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "an exact active dispatch plan no longer protects Planned",
    target: "src/scm-manual-split-authority.js",
    from: "      && hasActivePlan === true\n      && ![\"complete\", \"completed\", \"cancelled\", \"canceled\"].includes(normalizedDerived)",
    to: "      && false\n      && ![\"complete\", \"completed\", \"cancelled\", \"canceled\"].includes(normalizedDerived)",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "the status resolver ignores manual operational authority",
    target: "src/scm-reconciliation-repository.js",
    from: "  if (preserveOperationalStatus) return currentScheduleStatus;",
    to: "  if (false) return currentScheduleStatus;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "the PO catalog drops manual split status authority",
    target: "src/scm-purchase-order-catalog-status.js",
    from: "    preserveOperationalStatus\n  });",
    to: "    preserveOperationalStatus: false\n  });",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "PO Split borrows a reconciled parent status over an exact manual child status",
    target: "src/scm-purchase-order-catalog-repository.js",
    from: `    const exactManualSplitStatus = order.isScmSplit === true
      && Boolean(exactScheduleEvidence.schedule_id)
      && scmManualSplitHasOperationalStatusAuthority(exactScheduleEvidence.schedule_status, {
        hasActivePlan: order.dispatchPlanned === true,
        derivedStatus: exactScheduleEvidence.reconciliation_application_status
      });`,
    to: "    const exactManualSplitStatus = false;",
    tests: [CATALOG_TEST]
  },
  {
    name: "scheduled reconciliation derives over the held split child",
    target: "src/scm-reconciliation-repository.js",
    from: `    const preserveManualSplitOperationalStatus = order.kind === "PO"
      && target.targetKind === "po_split"
      && scmManualSplitHasOperationalStatusAuthority(manualSplitOperationalStatus, {
        hasActivePlan: target.hasActiveDispatchAssignment === true,
        derivedStatus: derived.applicationStatus
      });`,
    to: "    const preserveManualSplitOperationalStatus = false;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "a protected held child remains reconciliation-blocked",
    target: "src/scm-reconciliation-repository.js",
    from: "    const reconciliationBlocked = preserveManualSplitOperationalStatus ? false : blocked;",
    to: "    const reconciliationBlocked = true;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "schedule enrichment exposes parent-derived status on a held child",
    target: "src/scm-reconciliation-repository.js",
    from: `    const preserveManualSplitOperationalStatus = kind === "PO"
      && row.isScmSplit === true
      && scmManualSplitHasOperationalStatusAuthority(row.status, {
        hasActivePlan: row.dispatchPlanned === true,
        derivedStatus: row.calculatedStatus
      });`,
    to: "    const preserveManualSplitOperationalStatus = false;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "PO/TO Schedule drops active-plan authority for a planned split",
    target: "src/dispatch-repository.js",
    from: `        WHEN b.order_kind = 'PO'
          AND NULLIF(BTRIM(b.split_ref), '') IS NOT NULL
          AND planned.order_ref IS NOT NULL
          AND lower(BTRIM(COALESCE(operational_status.status, ''))) = 'planned'`,
    to: `        WHEN false
          AND NULLIF(BTRIM(b.split_ref), '') IS NOT NULL
          AND planned.order_ref IS NOT NULL
          AND lower(BTRIM(COALESCE(operational_status.status, ''))) = 'planned'`,
    tests: [CATALOG_TEST]
  },
  {
    name: "accept-current mass-overwrites a manual split schedule status",
    target: "src/scm-reconciliation-repository.js",
    from: "                  status = CASE WHEN $5::boolean THEN status ELSE $3 END,",
    to: "                  status = $3,",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "accept-current rewrites a split revision saved after the review snapshot",
    target: "src/scm-reconciliation-repository.js",
    from: `        const preserveNewerSplitRevision = source.kind === "PO"
          && target.targetKind === "po_split"
          && Number(acceptedSchedule.id) > 0
          && stateReconciledAt !== null
          && scheduleUpdatedAt !== null
          && scheduleUpdatedAt > stateReconciledAt;`,
    to: "        const preserveNewerSplitRevision = false;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "accept-current ignores an exact active split assignment",
    target: "src/scm-reconciliation-repository.js",
    from: `            || scmManualSplitHasOperationalStatusAuthority(preservedOperationalStatus, {
              hasActivePlan: target.hasActiveDispatchAssignment === true,
              derivedStatus: derived.applicationStatus
            })`,
    to: "            || false",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "an unchanged accepted reconciliation conflict reopens",
    target: "src/scm-reconciliation-repository.js",
    from: '  const activeReconciliationReason = acceptedCurrentEvidence ? "" : reconciliationReason;',
    to: "  const activeReconciliationReason = reconciliationReason;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "a legacy accepted conflict receives no evidence fingerprint",
    target: "src/scm-reconciliation-repository.js",
    from: `      acceptedConflictFingerprint = text(review.details?.conflictFingerprint)
        || persistedReconciliationConflictFingerprint(state, review);`,
    to: "      acceptedConflictFingerprint = text(review.details?.conflictFingerprint);",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "repair writes Queue instead of Hold",
    target: "src/scm-manual-split-authority-repository.js",
    from: 'const MANUAL_SPLIT_INITIAL_STATUS = "Hold";',
    to: 'const MANUAL_SPLIT_INITIAL_STATUS = "Queued";',
    tests: [INTEGRATION_TEST]
  },
  {
    name: "repair includes cancelled split children",
    target: "src/scm-manual-split-authority-repository.js",
    from: "          AND split.status = 'active'",
    to: "          AND split.status <> 'never'",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "targeted repair expands back to the entire active family",
    target: "src/scm-manual-split-authority-repository.js",
    from: `    const targetRows = requestedChildRefs.length
      ? requestedChildRefs.map((ref) => rowsByRef.get(ref.toLowerCase()))
      : familyResult.rows;`,
    to: "    const targetRows = familyResult.rows;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "targeted repair ignores the expected current status guard",
    target: "src/scm-manual-split-authority-repository.js",
    from: `        expectedStatus
        && text(row.schedule_status).toLowerCase() !== expectedStatus.toLowerCase()`,
    to: `        false
        && text(row.schedule_status).toLowerCase() !== expectedStatus.toLowerCase()`,
    tests: [INTEGRATION_TEST]
  },
  {
    name: "Planned repair ignores the exact active assignment guard",
    target: "src/scm-manual-split-authority-repository.js",
    from: "      if (cleanReplacementStatus === \"Planned\" && row.has_active_plan !== true) {",
    to: "      if (false) {",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "targeted Planned repair writes Hold instead",
    target: "src/scm-manual-split-authority-repository.js",
    from: "        [orderRef, cleanReplacementStatus, after.dropoffPoint, cleanActor]",
    to: "        [orderRef, MANUAL_SPLIT_INITIAL_STATUS, after.dropoffPoint, cleanActor]",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "repair accepts a destination that conflicts with the child mirror",
    target: "src/scm-manual-split-authority-repository.js",
    from: "        || confirmedLocation !== text(row.child_location)",
    to: "        || false",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "repair dry-run commits its writes",
    target: "src/scm-manual-split-authority-repository.js",
    from: "  }, { rollback: dryRun === true });",
    to: "  }, { rollback: false });",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "repair omits its per-child audit action",
    target: "src/scm-manual-split-authority-repository.js",
    from: '        action: "scm.manual_split_authority_repaired",',
    to: '        action: "scm.manual_split_authority_repair_missing",',
    tests: [INTEGRATION_TEST]
  }
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function runTests(label, tests = ALL_TESTS) {
  process.stdout.write(`\n[manual split authority mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...tests
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
  throw new Error("Manual split authority mutations require the writable disposable mutation container.");
}

const targetNames = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const originalHashes = new Map();
for (const target of targetNames) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  originalHashes.set(target, hash(source));
}

if (runTests("baseline") !== 0) {
  throw new Error("Focused mutation tests do not start green.");
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (original === undefined) {
      throw new Error(`Missing mutation source ${mutant.target}.`);
    }
    const expectedOccurrences = mutant.occurrences || 1;
    if (occurrenceCount(original, mutant.from) !== expectedOccurrences) {
      throw new Error(`${mutant.name}: expected ${expectedOccurrences} mutation target occurrence(s).`);
    }
    await writeFile(
      path.resolve(mutant.target),
      original.replaceAll(mutant.from, mutant.to),
      "utf8"
    );
    if (runTests(mutant.name, mutant.tests) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const target of targetNames) {
    const original = originals.get(target);
    if (original === undefined) {
      continue;
    }
    await writeFile(path.resolve(target), original, "utf8");
    if (hash(await readFile(path.resolve(target), "utf8")) !== originalHashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(
  `Manual split authority mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`
);
