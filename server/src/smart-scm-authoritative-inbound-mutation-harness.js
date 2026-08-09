import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const planningPath = path.join(serverRoot, "src/smart-scm-planning-repository.js");
const editorPath = path.join(serverRoot, "src/smart-scm-proposal-editor.js");
const validatorPath = path.join(serverRoot, "src/smart-scm-run-validator.js");
const proposalUiPath = path.join(serverRoot, "public/scm-smart-proposals.js");
const originals = new Map([
  [planningPath, await readFile(planningPath, "utf8")],
  [editorPath, await readFile(editorPath, "utf8")],
  [validatorPath, await readFile(validatorPath, "utf8")],
  [proposalUiPath, await readFile(proposalUiPath, "utf8")]
]);

function replaceExact(source, from, to, expectedCount = 1) {
  const count = source.split(from).length - 1;
  assert.equal(count, expectedCount, `Mutation target count changed for: ${from}`);
  return source.replaceAll(from, to);
}

const mutations = [
  {
    name: "stop subtracting locally flagged blanket PO quantity",
    file: planningPath,
    test: "src/smart-scm-authoritative-inbound-harness.js",
    expectedFailure: /10 PLT authoritative on-order/i,
    mutate(source) {
      return replaceExact(
        source,
        "Math.max(0, authoritative - blanketExcluded - transferExcluded)",
        "Math.max(0, authoritative - transferExcluded)"
      );
    }
  },
  {
    name: "stop subtracting the proposal's own transfer order",
    file: planningPath,
    test: "src/smart-scm-authoritative-inbound-harness.js",
    expectedFailure: /10 PLT authoritative on-order/i,
    mutate(source) {
      return replaceExact(
        source,
        "Math.max(0, authoritative - blanketExcluded - transferExcluded)",
        "Math.max(0, authoritative - blanketExcluded)"
      );
    }
  },
  {
    name: "add locally mirrored PO and TO lines on top of NetSuite on-order",
    file: planningPath,
    test: "src/smart-scm-authoritative-inbound-harness.js",
    expectedFailure: /10 PLT authoritative on-order/i,
    mutate(source) {
      let mutated = replaceExact(
        source,
        "pendingTransferReservationSales = 0\n} = {}) {",
        "pendingTransferReservationSales = 0,\n  localPurchaseAndTransferSales = 0\n} = {}) {"
      );
      mutated = replaceExact(
        mutated,
        "+ transferReserved\n    )",
        "+ transferReserved\n        + positive(localPurchaseAndTransferSales)\n    )"
      );
      return mutated;
    }
  },
  {
    name: "stop subtracting NetSuite aggregate backorder",
    file: planningPath,
    test: "src/smart-scm-authoritative-inbound-harness.js",
    expectedFailure: /PO need must use available/i,
    mutate(source) {
      return replaceExact(
        source,
        "available + inbound.effectiveOnOrderSales - backordered - outboundReserved",
        "available + inbound.effectiveOnOrderSales - outboundReserved"
      );
    }
  },
  {
    name: "subtract a closed flagged blanket PO in automatic planning",
    file: planningPath,
    test: "src/smart-scm-authoritative-inbound-integration-harness.js",
    expectedFailure: /closed flagged blanket PO must not be subtracted/i,
    mutate(source) {
      return replaceExact(
        source,
        "          AND po.is_blanket_po = true\n          AND NOT COALESCE(line.netsuite_closed, false)\n          AND (po.status_text ILIKE '%Pending Receipt%' OR po.status_text ILIKE '%Partially Received%')",
        "          AND po.is_blanket_po = true\n          AND NOT COALESCE(line.netsuite_closed, false)"
      );
    }
  },
  {
    name: "subtract a closed flagged blanket PO in manual recalculation",
    file: editorPath,
    test: "src/smart-scm-authoritative-inbound-harness.js",
    expectedFailure: /manual proposal recalculation must subtract only open flagged blanket/i,
    mutate(source) {
      return replaceExact(
        source,
        "                 AND (po.status_text ILIKE '%Pending Receipt%' OR po.status_text ILIKE '%Partially Received%')\n",
        ""
      );
    }
  },
  {
    name: "preserve stale legacy expected-availability evidence",
    file: planningPath,
    test: "src/smart-scm-authoritative-inbound-integration-harness.js",
    expectedFailure: /replace stale legacy expected-availability evidence/i,
    mutate(source) {
      return replaceExact(
        source,
        "      expectedAvailablePallets: round(Math.max(0, state.positionPallets)),\n",
        ""
      );
    }
  },
  {
    name: "restore stale normal urgency during manual proposal edits",
    file: editorPath,
    test: "src/smart-scm-authoritative-inbound-integration-harness.js",
    expectedFailure: /manual creation must not hardcode urgent=false/i,
    mutate(source) {
      return replaceExact(source, "urgent: calculated.urgent,", "urgent: false,");
    }
  },
  {
    name: "ignore zero available stock when classifying a shortage",
    file: planningPath,
    test: "src/smart-scm-urgency-harness.js",
    expectedFailure: /Zero available stock with a positive calculated need must always be urgent/i,
    mutate(source) {
      return replaceExact(
        source,
        "  const urgent = required > 0 && (\n    availablePallets <= EPSILON\n    || positionPallets <= safety + EPSILON\n    || weeksOfCover <= leadWeeks + EPSILON\n  );",
        "  const urgent = required > 0 && (\n    positionPallets <= safety + EPSILON\n    || weeksOfCover <= leadWeeks + EPSILON\n  );"
      );
    }
  },
  {
    name: "add direct coverage and a full fallback copy",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /fully covered non-hub need must not receive an additional vendor-hub PO/i,
    mutate(source) {
      return replaceExact(
        source,
        "let transferNeed = Math.max(0, state.requiredPallets - directPallets);",
        "let transferNeed = Math.max(0, state.requiredPallets);"
      );
    }
  },
  {
    name: "subtract direct coverage twice from the residual",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /Only the uncovered 4-PLT residual may become a vendor-hub fallback/i,
    mutate(source) {
      return replaceExact(
        source,
        "let transferNeed = Math.max(0, state.requiredPallets - directPallets);",
        "let transferNeed = Math.max(0, state.requiredPallets - (directPallets * 2));"
      );
    }
  },
  {
    name: "remove the same-yard vendor-hub guard",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /Hub demand must not loop through vendor_hub/i,
    mutate(source) {
      return replaceExact(
        source,
        "        && !purchasePlanningExcluded\n        && Number(state.policy.location_id) !== hub.locationId) {",
        "        && !purchasePlanningExcluded) {"
      );
    }
  },
  {
    name: "suppress every legitimate vendor-hub fallback",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /Only the uncovered 4-PLT residual may become a vendor-hub fallback/i,
    mutate(source) {
      return replaceExact(
        source,
        "        && Number(state.policy.location_id) !== hub.locationId) {",
        "        && false) {"
      );
    }
  },
  {
    name: "route through the wrong yard as the vendor hub",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /Only the uncovered 4-PLT residual may become a vendor-hub fallback/i,
    mutate(source) {
      return replaceExact(
        source,
        "const hub = YARDS.find((yard) => yard.code === \"12441\");",
        "const hub = YARDS.find((yard) => yard.code === \"3445\");"
      );
    }
  },
  {
    name: "compare the destination yard code to the hub location id",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /Hub demand must not loop through vendor_hub/i,
    mutate(source) {
      return replaceExact(
        source,
        "Number(state.policy.location_id) !== hub.locationId",
        "Number(state.policy.yard_code) !== hub.locationId"
      );
    }
  },
  {
    name: "attribute a vendor-hub line to its physical hub instead of its real yard",
    file: validatorPath,
    test: "src/smart-scm-run-validator-harness.js",
    expectedFailure: /conserved three-phase plan must pass validation/i,
    mutate(source) {
      return replaceExact(
        source,
        "return String(line?.reason?.actualDestinationYard || line?.destinationName || \"\").trim();",
        "return String(line?.destinationName || line?.reason?.actualDestinationYard || \"\").trim();"
      );
    }
  },
  {
    name: "ignore per-yard proposal coverage above required quantity",
    file: validatorPath,
    test: "src/smart-scm-run-validator-harness.js",
    expectedFailure: /Per-yard duplicate coverage must be detected/i,
    mutate(source) {
      return replaceExact(
        source,
        "if (proposedPallets > requiredPallets + EPSILON) {",
        "if (false) {"
      );
    }
  },
  {
    name: "ignore four-yard SKU coverage above summed required quantity",
    file: validatorPath,
    test: "src/smart-scm-run-validator-harness.js",
    expectedFailure: /Four-yard SKU duplicate coverage must be detected/i,
    mutate(source) {
      return replaceExact(
        source,
        "if (sku.proposedPallets > sku.requiredPallets + EPSILON) {",
        "if (false) {"
      );
    }
  },
  {
    name: "ignore state-level zero-available urgency failures",
    file: validatorPath,
    test: "src/smart-scm-run-validator-harness.js",
    expectedFailure: /state-level zero-stock urgency must be detected/i,
    mutate(source) {
      return replaceExact(source, "      if (!state.urgent) {", "      if (false) {");
    }
  },
  {
    name: "ignore a vendor-hub PO that loops through 12441",
    file: validatorPath,
    test: "src/smart-scm-run-validator-harness.js",
    expectedFailure: /self-hub proposal must fail validation/i,
    mutate(source) {
      return replaceExact(
        source,
        "if (proposal.phase === \"vendor_hub\" && yard === \"12441\") {",
        "if (false) {"
      );
    }
  },
  {
    name: "discard the per-yard allocation ledger while merging one physical hub line",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /destinationAllocations|physical hub line|Cannot read properties of undefined/i,
    mutate(source) {
      return replaceExact(
        source,
        "    || lineDemandDestination(existing) !== lineDemandDestination(next);",
        "    || false;"
      );
    }
  },
  {
    name: "copy the complete yard-allocation ledger onto every repacked pallet",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /priority-repacked physical line must conserve|Destination allocation total must match/i,
    mutate(source) {
      return replaceExact(
        source,
        "const destinationAllocations = takeDestinationAllocations(pallets);",
        "const destinationAllocations = savedDestinationAllocations.length ? savedDestinationAllocations : null;"
      );
    }
  },
  {
    name: "keep direct-vendor and vendor-hub quantities in separate physical loads",
    file: planningPath,
    test: "src/smart-scm-purchase-conservation-harness.js",
    expectedFailure: /same vendor must share one physical load/i,
    mutate(source) {
      return replaceExact(
        source,
        "  const phase = draft.proposalType === \"PO\" && [\"direct_vendor\", \"vendor_hub\"].includes(draft.phase)\n    ? \"vendor_purchase\"\n    : draft.phase;",
        "  const phase = draft.phase;"
      );
    }
  },
  {
    name: "ignore an explicit per-yard allocation ledger during validation",
    file: validatorPath,
    test: "src/smart-scm-run-validator-harness.js",
    expectedFailure: /exact two-yard allocation ledger must validate per yard/i,
    mutate(source) {
      return replaceExact(
        source,
        "  const saved = Array.isArray(line.reason?.destinationAllocations)\n    ? line.reason.destinationAllocations\n    : [];",
        "  const saved = [];"
      );
    }
  },
  {
    name: "accept an allocation ledger whose quantities do not sum to its physical line",
    file: validatorPath,
    test: "src/smart-scm-run-validator-harness.js",
    expectedFailure: /must reject an allocation ledger/i,
    mutate(source) {
      return replaceExact(
        source,
        "if (Math.abs(allocationTotal - lineProposedPallets) > EPSILON) {",
        "if (false) {"
      );
    }
  },
  {
    name: "label every grouped hub allocation as vendor direct",
    file: proposalUiPath,
    test: "src/smart-scm-calculation-ui-harness.js",
    expectedFailure: /Transfer later/i,
    mutate(source) {
      return replaceExact(
        source,
        "const label = allocation.fulfillment === \"transfer_later\" ? \"Transfer later\" : \"Vendor direct\";",
        "const label = \"Vendor direct\";"
      );
    }
  },
  {
    name: "hide the HUB marker from every hub-routed availability cell",
    file: proposalUiPath,
    test: "src/smart-scm-calculation-ui-harness.js",
    expectedFailure: /must show HUB in Availability/i,
    mutate(source) {
      return replaceExact(
        source,
        "  return smartProposalIsHubLine(proposal, line)\n    ? '<span class=\"smart-availability-hub-tag\" title=\"This line uses the vendor hub for receipt or onward transfer.\">HUB</span>'\n    : \"\";",
        "  return \"\";"
      );
    }
  },
  {
    name: "mislabel every vendor-direct PO as a HUB line",
    file: proposalUiPath,
    test: "src/smart-scm-calculation-ui-harness.js",
    expectedFailure: /vendor-direct PO line.*must not be labeled HUB/i,
    mutate(source) {
      return replaceExact(
        source,
        "  if (proposal.proposalType !== \"PO\") return false;",
        "  if (proposal.proposalType === \"PO\") return true;"
      );
    }
  },
  {
    name: "hide the capacity warning when preferred stock is below ROP",
    file: proposalUiPath,
    test: "src/smart-scm-calculation-ui-harness.js",
    expectedFailure: /preferred target below ROP must explicitly explain/i,
    mutate(source) {
      return replaceExact(
        source,
        "const preferredBelowReorderPoint = hasPolicyDecision && preferred + 0.000001 < reorderPoint;",
        "const preferredBelowReorderPoint = false;"
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
      maxBuffer: 30 * 1024 * 1024,
      timeout: 300_000
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

assert.equal(killed, mutations.length, "Every Smart SCM authoritative-inventory mutant must be killed.");
console.log(`Smart SCM authoritative inventory mutation harness passed: ${killed}/${mutations.length} mutants killed.`);
