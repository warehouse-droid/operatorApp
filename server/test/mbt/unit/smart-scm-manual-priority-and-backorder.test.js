import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  smartScmConfirmationSourceTransferBlocked,
  smartScmConfirmationSourceTransferLimit
} from "../../../src/smart-scm-planning-repository.js";

const publicUrl = new URL("../../../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function manualPriorityFixture(proposal = {}) {
  const key = String(proposal.proposalKey || "");
  const reasons = (proposal.lines || []).map((line) => line.reason || {});
  return key.startsWith("manual-load:")
    || key.startsWith("blanket-split:")
    || key.startsWith("blanket-merge:")
    || reasons.some((reason) => reason.manualLoad === true
      || reason.manuallyAdded === true
      || reason.manuallyAdjusted === true
      || reason.manuallySplit === true
      || reason.blanketManuallyAdjusted === true
      || reason.blanketMerge === true)
    ? 0
    : 1;
}

test("manual PO/TO loads sort ahead of more urgent automatic proposals", () => {
  const source = readPublic("scm-smart-proposals.js");
  const sorter = sourceBetween(
    source,
    "smartFilteredProposals = function smartFilteredProposalsV2()",
    "\n\nfunction smartProposalLineRow"
  );
  const smartState = {
    planSearch: "",
    planType: "",
    planStatus: "",
    planVendor: "",
    planSource: "",
    planDestination: "",
    planSort: "destination",
    plan: {
      proposals: [
        {
          id: 1,
          proposalKey: "automatic:urgent",
          proposalType: "TO",
          urgencyLevel: "ultimate_urgent",
          urgencyScore: 100,
          sourceName: "3445",
          destinationName: "12441",
          lines: []
        },
        {
          id: 99,
          proposalKey: "manual-load:harness",
          proposalType: "TO",
          urgencyLevel: "normal",
          urgencyScore: 0,
          sourceName: "2967",
          destinationName: "150",
          lines: [{ reason: { manualLoad: true } }]
        }
      ]
    }
  };
  const context = vm.createContext({
    smartState,
    smartProposalManualPriority: manualPriorityFixture,
    smartUrgencyRank: (level) => ({ normal: 0, urgent: 1, super_urgent: 2, ultimate_urgent: 3 })[level] || 0,
    smartProposalUrgencyLevel: (proposal) => proposal.urgencyLevel,
    smartProposalUrgencyScore: (proposal) => proposal.urgencyScore,
    smartProposalDestinationPriority: () => 0,
    smartProposalStops: (proposal) => [{ name: proposal.destinationName }],
    smartProposalRoute: (proposal) => `${proposal.sourceName} -> ${proposal.destinationName}`,
    smartNormalizedVendor: (value) => String(value || "").toLowerCase(),
    smartProposalVendor: (proposal) => proposal.vendor || proposal.sourceName || ""
  });
  vm.runInContext(`let smartFilteredProposals; ${sorter}\nglobalThis.ids = smartFilteredProposals().map((proposal) => proposal.id);`, context);
  assert.deepEqual([...context.ids], [99, 1]);
});

test("manually created or changed Blanket loads sort at the top", () => {
  const source = readPublic("scm-smart-blanket.js");
  const sorter = sourceBetween(
    source,
    "function smartBlanketSortedProposals",
    "\n\nfunction smartBlanketSidebarTab"
  );
  const context = vm.createContext({
    smartProposalManualPriority: manualPriorityFixture,
    smartProposalUrgencyLevel: (proposal) => proposal.urgencyLevel
  });
  vm.runInContext(`${sorter}\nglobalThis.ids = smartBlanketSortedProposals([
    { id: 2, proposalKey: "blanket:automatic", urgencyLevel: "ultimate_urgent", destinationName: "3445", lines: [] },
    { id: 88, proposalKey: "blanket-split:harness", urgencyLevel: "normal", destinationName: "150", lines: [{ reason: { manuallySplit: true } }] }
  ]).map((proposal) => proposal.id);`, context);
  assert.deepEqual([...context.ids], [88, 2]);
});

test("the shared manual-priority classifier covers PO/TO and Blanket provenance", () => {
  const source = readPublic("scm-smart.js");
  const classifier = sourceBetween(
    source,
    "function smartProposalManualPriority",
    "\n\nfunction smart"
  );
  const context = vm.createContext({});
  vm.runInContext(`${classifier}\nglobalThis.rank = smartProposalManualPriority;`, context);
  assert.equal(context.rank({ proposalKey: "manual-load:one", lines: [] }), 0);
  assert.equal(context.rank({ proposalKey: "blanket-split:two", lines: [] }), 0);
  assert.equal(context.rank({ proposalKey: "blanket:three", lines: [{ reason: { blanketManuallyAdjusted: true } }] }), 0);
  assert.equal(context.rank({ proposalKey: "automatic:four", lines: [{ reason: {} }] }), 1);
});

test("a manually entered TO quantity can create a source backorder without weakening automatic limits", () => {
  const manual = smartScmConfirmationSourceTransferLimit({
    availablePallets: 3.2,
    safetyStockPallets: 2,
    reorderPointPallets: 1,
    requestedPallets: 8,
    manualOverride: true
  });
  assert.equal(manual.allowBackorder, true);
  assert.equal(manual.backorderPallets, 4.8);
  assert.equal(manual.maximumTransferablePallets, 3,
    "The physical availability fact must remain accurate even though a manual order may backorder.");
  assert.equal(smartScmConfirmationSourceTransferBlocked({ requestedPallets: 8, limit: manual }), false,
    "Confirmation must accept the explicit manual backorder intent.");

  const automatic = smartScmConfirmationSourceTransferLimit({
    availablePallets: 3.2,
    safetyStockPallets: 2,
    reorderPointPallets: 1,
    requestedPallets: 8,
    manualOverride: false
  });
  assert.equal(automatic.allowBackorder, false);
  assert.equal(automatic.backorderPallets, 0);
  assert.equal(automatic.maximumTransferablePallets, 1,
    "Automatic TO planning must still protect source safety stock and its reorder point.");
  assert.equal(smartScmConfirmationSourceTransferBlocked({ requestedPallets: 8, limit: automatic }), true,
    "The same quantity must remain blocked when it came from automatic planning.");
});
