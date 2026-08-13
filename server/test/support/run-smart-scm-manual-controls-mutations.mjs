// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const UNIT = "test/mbt/unit/smart-scm-manual-priority-and-backorder.test.js";
const PROPERTY = "test/mbt/property/smart-scm-blanket-manual-reallocation.property.test.js";
const BLANKET_INTEGRATION = "test/mbt/integration/smart-scm-blanket-manual-reallocation.test.js";
const BLANKET_SOURCE_ITEM = "test/mbt/integration/smart-scm-blanket-source-item-add.test.js";
const TO_INTEGRATION = "test/mbt/integration/smart-scm-manual-to-backorder.test.js";
const VENDOR_UI = "src/smart-scm-vendor-ui-harness.js";
const MUTANTS = Object.freeze([
  {
    name: "manual-load proposal keys lose priority",
    target: "public/scm-smart.js",
    tests: [UNIT],
    from: "const manualKey = [\"manual-load:\", \"blanket-split:\", \"blanket-merge:\"]",
    to: "const manualKey = [\"blanket-split:\", \"blanket-merge:\"]"
  },
  {
    name: "PO and TO proposal sorting ignores manual priority",
    target: "public/scm-smart-proposals.js",
    tests: [UNIT],
    from: "return proposals.sort((left, right) => smartProposalManualPriority(left) - smartProposalManualPriority(right)",
    to: "return proposals.sort((left, right) => 0"
  },
  {
    name: "Blanket proposal sorting ignores manual priority",
    target: "public/scm-smart-blanket.js",
    tests: [UNIT],
    from: "return [...proposals].sort((left, right) => smartProposalManualPriority(left) - smartProposalManualPriority(right)",
    to: "return [...proposals].sort((left, right) => 0"
  },
  {
    name: "manual TO limits no longer authorize backorders",
    target: "src/smart-scm-planning-repository.js",
    tests: [UNIT, TO_INTEGRATION],
    from: "    allowBackorder: manual,",
    to: "    allowBackorder: false,"
  },
  {
    name: "confirmation ignores the manual backorder authorization",
    target: "src/smart-scm-planning-repository.js",
    tests: [UNIT, TO_INTEGRATION],
    from: "  return limit?.allowBackorder !== true\n    && positive(requestedPallets) > positive(limit?.maximumTransferablePallets) + EPSILON;",
    to: "  return positive(requestedPallets) > positive(limit?.maximumTransferablePallets) + EPSILON;"
  },
  {
    name: "Blanket donor reduction omits the edited quantity",
    target: "src/smart-scm-blanket-repository.js",
    tests: [PROPERTY, BLANKET_INTEGRATION],
    from: "const requiredReductionPallets = Math.max(0, round(requested + competingBeforePallets - open));",
    to: "const requiredReductionPallets = Math.max(0, round(competingBeforePallets - open));"
  },
  {
    name: "Blanket physical ceiling allows one extra pallet",
    target: "src/smart-scm-blanket-repository.js",
    tests: [PROPERTY, BLANKET_INTEGRATION],
    from: "  if (requested > open) {",
    to: "  if (requested > open + 1) {"
  },
  {
    name: "Blanket edits rebalance another planning run",
    target: "src/smart-scm-blanket-repository.js",
    tests: [BLANKET_INTEGRATION],
    from: "        WHERE other_proposal.run_id = $1\n          AND other_proposal.status = 'held'",
    to: "        WHERE other_proposal.run_id <> $1\n          AND other_proposal.status = 'held'"
  },
  {
    name: "Blanket edits may take back reserved allocations",
    target: "src/smart-scm-blanket-repository.js",
    tests: [BLANKET_INTEGRATION],
    from: "          AND allocation.status = 'planned'\n          AND allocation.release_id IS NULL\n        ORDER BY other_proposal.id DESC",
    to: "          AND allocation.status IN ('planned', 'reserved')\n        ORDER BY other_proposal.id DESC"
  },
  {
    name: "zero-quantity Blanket donor proposals remain stranded",
    target: "src/smart-scm-blanket-repository.js",
    tests: [BLANKET_INTEGRATION],
    from: "      if (Number(remainingLines.rows[0]?.count || 0) === 0) {",
    to: "      if (Number(remainingLines.rows[0]?.count || 0) < 0) {"
  },
  {
    name: "Blanket source-item add accepts a purchase line from another PO",
    target: "src/smart-scm-blanket-repository.js",
    tests: [BLANKET_SOURCE_ITEM],
    from: "  return Boolean(source)\n    && Number(source.purchase_order_id) === Number(proposal.blanket_source_po_id)\n    && Number(source.item_id) === Number(itemId)\n    && text(source.source_po_ref).toLowerCase() === text(proposal.blanket_source_po_ref).toLowerCase();",
    to: "  return Boolean(source)\n    && Number(source.item_id) === Number(itemId);"
  },
  {
    name: "Blanket source-item add ignores sibling planned quantity",
    target: "src/smart-scm-blanket-repository.js",
    tests: [BLANKET_SOURCE_ITEM],
    from: "    const plannedPallets = positive(plannedBySourceLine.get(sourceLineId));\n    const availablePallets = Math.max(0, Math.floor(physicalOpenPallets - plannedPallets + EPSILON));",
    to: "    const plannedPallets = positive(plannedBySourceLine.get(sourceLineId));\n    const availablePallets = Math.max(0, Math.floor(physicalOpenPallets + EPSILON));"
  },
  {
    name: "PO preview discards the authenticated server error",
    target: "public/scm-smart-vendor.js",
    tests: [VENDOR_UI],
    from: "    if (!response.ok) {",
    to: "    if (false && !response.ok) {"
  }
]);

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Smart SCM manual-control mutations require the writable disposable MBT test container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map(await Promise.all(targets.map(async (target) => {
  const absolute = path.resolve(target);
  return /** @type {[string, { absolute: string, source: string }]} */ (
    [target, { absolute, source: await readFile(absolute, "utf8") }]
  );
})));
/** @param {string} target */
function originalFor(target) {
  const original = originals.get(target);
  if (!original) {
    throw new Error(`Missing mutation source snapshot: ${target}`);
  }
  return original;
}
const originalDigest = createHash("sha256");
for (const target of targets) {
  originalDigest.update(originalFor(target).source);
}
const expectedDigest = originalDigest.digest("hex");
let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originalFor(mutant.target);
    if (occurrenceCount(original.source, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(original.absolute, original.source.replace(mutant.from, mutant.to), "utf8");
    const result = await runNodeTestFilesIsolated(mutant.tests, {
      environment: process.env,
      label: `Smart SCM manual-control mutant: ${mutant.name}`
    });
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regressions.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(original.absolute, original.source, "utf8");
  }
} finally {
  for (const original of originals.values()) {
    await writeFile(original.absolute, original.source, "utf8");
  }
  const restoredDigest = createHash("sha256");
  for (const target of targets) {
    restoredDigest.update(await readFile(originalFor(target).absolute, "utf8"));
  }
  if (restoredDigest.digest("hex") !== expectedDigest) {
    throw new Error("Smart SCM manual-control mutation source restoration failed.");
  }
}

const finalResult = await runNodeTestFilesIsolated(
  [UNIT, PROPERTY, BLANKET_INTEGRATION, BLANKET_SOURCE_ITEM, TO_INTEGRATION, VENDOR_UI],
  { environment: process.env, label: "Smart SCM manual-control post-mutation green" }
);
if (finalResult !== 0) {
  throw new Error("Smart SCM manual-control tests failed after restoring mutation sources.");
}
console.log(`Smart SCM manual-control mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
