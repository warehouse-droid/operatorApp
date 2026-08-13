import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  smartScmBlanketProposalSourceForState,
  smartScmBlanketProposalSourceMatchesPolicy
} from "../../../src/smart-scm-blanket-repository.js";

const repositorySource = await readFile(
  new URL("../../../src/smart-scm-blanket-repository.js", import.meta.url),
  "utf8"
);

test("Blanket planning routes an Item Master vendor-yard override into persisted proposal identity", () => {
  const purchaseOrderSource = {
    source_po_id: 31604,
    source_po_ref: "POB03669",
    pickup_point: "Ayr Yard - Unilock",
    vendor: "Unilock"
  };
  const routed = smartScmBlanketProposalSourceForState(purchaseOrderSource, {
    policy: {
      item_id: 1134,
      item_name: "UNI-PISA2-STD-GN",
      vendor_yard_id: 2,
      plant: "UNILOCK Gormley",
      configured_vendor_yard: "Gormley"
    }
  });

  assert.equal(routed.source_vendor_yard_id, 2);
  assert.equal(routed.pickup_point, "UNILOCK Gormley");
  assert.equal(purchaseOrderSource.pickup_point, "Ayr Yard - Unilock",
    "Planning must derive a new source without mutating the PO header fixture.");
});

test("Blanket planning retains the PO header yard when Item Master has no explicit override", () => {
  const routed = smartScmBlanketProposalSourceForState({
    source_po_id: 50,
    source_po_ref: "PO-NO-OVERRIDE",
    pickup_point: "PO Header Yard",
    vendor: "Vendor fallback"
  }, {
    policy: {
      vendor_yard_id: null,
      configured_vendor_yard: "",
      configured_plant: "",
      plant: "Vendor fallback"
    }
  });

  assert.equal(routed.source_vendor_yard_id, null);
  assert.equal(routed.pickup_point, "PO Header Yard");
});

test("a saved wrong-yard Blanket proposal is stale while the current persisted route is accepted", () => {
  const itemMasterPolicy = {
    vendor_yard_id: 2,
    vendor_yard: "UNILOCK Gormley",
    configured_vendor_yard: "Gormley",
    configured_plant: ""
  };

  assert.equal(smartScmBlanketProposalSourceMatchesPolicy({
    source_vendor_yard_id: null,
    source_name: "Ayr Yard - Unilock"
  }, itemMasterPolicy), false);
  assert.equal(smartScmBlanketProposalSourceMatchesPolicy({
    source_vendor_yard_id: 2,
    source_name: "UNILOCK Gormley"
  }, itemMasterPolicy), true);
  assert.equal(smartScmBlanketProposalSourceMatchesPolicy({
    source_vendor_yard_id: 2,
    source_name: "Ayr Yard - Unilock"
  }, itemMasterPolicy), false,
  "Matching only the numeric ID is insufficient because downstream Dispatch uses the persisted pickup name.");
});

test("Blanket routing is persisted and passed into the created split PO, not applied only by the UI", () => {
  assert.match(repositorySource,
    /source_kind, source_vendor_yard_id, source_name[\s\S]*?integer\(source\.source_vendor_yard_id\)/u,
    "The calculated vendor-yard identity must be inserted into scm_smart_proposals.");
  assert.match(repositorySource,
    /createScmPurchaseOrderSplit\(\{[\s\S]*?pickupPoint:\s*proposal\.source_name\s*\|\|\s*proposal\.plant/u,
    "The local split PO and transport schedule must receive the proposal's Item Master pickup yard.");
  assert.match(repositorySource,
    /SCM_BLANKET_VENDOR_YARD_CHANGED/u,
    "A stale saved proposal must fail closed before reservation or execution.");
});
