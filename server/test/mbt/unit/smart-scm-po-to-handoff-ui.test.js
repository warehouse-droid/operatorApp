import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../../../public/scm-smart-proposals.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../../../public/scm-smart.html", import.meta.url), "utf8");

function context() {
  const result = vm.createContext({
    smartState: { selectedProposalIds: new Set(), data: {}, plan: null },
    smartCanWrite: () => true,
    smartNumber: (value) => Number(value).toLocaleString("en-CA"),
    smartEscape: (value) => String(value ?? "").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    smartScmApp: { addEventListener() {} },
    smartPill: () => "",
    document: { querySelector: () => null, getElementById: () => null },
    setTimeout, clearTimeout, URLSearchParams, Map, Set, Intl
  });
  vm.runInContext(source, result);
  return result;
}

test("phase review explains that Order Request is the coverage point", () => {
  const ui = context();
  const html = ui.smartPlanningPhasePanel({ planningPhase: "po_pending_approval" });
  assert.match(html, /Order Request/);
  assert.match(html, /unrequested.*(transfer|Transfer)/);
  assert.doesNotMatch(html, /Approve only after the intended POs.*exist/);
  assert.match(page, /scm-smart-proposals\.js\?[^"\n]*handoff=20261022-v1/);
});

test("TO inventory calculation explains requested coverage and the remaining need", () => {
  const ui = context();
  const html = ui.smartProposalDestinationCalculation({ proposalType: "TO", destinationName: "150" }, {
    toPlt: 60, destinationName: "150", requiredPallets: 5, proposedPallets: 5,
    reason: { quantityAvailable: 0, quantityOnOrder: 0, quantityBackordered: 0, quantityReservedOutbound: 0,
      positionPallets: 0, reorderPointPallets: 5, preferredPallets: 8, minimumOrderPallets: 1,
      capacityPallets: 32, requestedPoCoveragePallets: 3, residualRequiredPallets: 5 }
  });
  assert.match(html, /Order Request coverage: <strong>3 PLT<\/strong>/);
  assert.match(html, /remaining for TO planning: <strong>5 PLT<\/strong>/);
  assert.doesNotMatch(html, /differs after editing\/grouping/);
});

test("frozen phase panel reports request coverage while legacy plans keep their evidence", () => {
  const ui = context();
  const html = ui.smartPlanningPhasePanel({ planningPhase: "transfer_ready",
    phaseTwoBasis: { requestedPoLines: [{ requestedPallets: 3 }, { requestedPallets: 2 }] } });
  assert.match(html, /Order Request coverage:.*5 PLT/);
  const legacy = ui.smartPlanningPhasePanel({ planningPhase: "transfer_ready", phaseTwoBasis: {} });
  assert.match(legacy, /The PO evidence used for this run is frozen/);
  assert.doesNotMatch(legacy, /Order Request coverage:/);
});
