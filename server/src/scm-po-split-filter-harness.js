import assert from "node:assert/strict";
import fs from "node:fs";
import {
  scmPurchaseOrderListKind,
  scmPurchaseOrderMatchesListFilters
} from "./dispatch-repository.js";

const parent = {
  id: "PO100",
  sourceTable: "purchase_orders",
  isScmSplit: false,
  childOrders: ["PO100-S1"],
  destinationYard: "150",
  dropoffs: [{ destinationYard: "3445" }],
  sourceYard: "Vendor Yard",
  vendorYardOptions: [{ yard: "Vendor Yard", vendor: "Vendor A" }],
  scm: { pickupPoint: "Vendor Yard" }
};
const neverSplit = { ...parent, id: "PO200", childOrders: [] };
const splitChild = {
  ...parent,
  id: "PO100-S1",
  isScmSplit: true,
  sourcePoRef: "PO100",
  childOrders: []
};
const vrma = {
  ...parent,
  id: "VRMA100",
  sourceTable: "scm_vrma_orders",
  parseSource: "scm-vrma"
};

assert.equal(scmPurchaseOrderListKind(parent), "po", "A source PO remains in the PO quick filter.");
assert.equal(scmPurchaseOrderListKind(neverSplit), "po", "A never-split PO remains in the PO quick filter.");
assert.equal(scmPurchaseOrderListKind(splitChild), "split", "An active split-ledger child belongs to Split PO.");
assert.equal(scmPurchaseOrderListKind(vrma), "vrma", "VRMA must be identified independently from PO.");

assert.equal(scmPurchaseOrderMatchesListFilters(parent, { poType: "po" }), true);
assert.equal(scmPurchaseOrderMatchesListFilters(neverSplit, { poType: "po" }), true);
assert.equal(scmPurchaseOrderMatchesListFilters(splitChild, { poType: "po" }), false);
assert.equal(scmPurchaseOrderMatchesListFilters(splitChild, { poType: "split" }), true);
assert.equal(scmPurchaseOrderMatchesListFilters(parent, { poType: "split" }), false);
assert.equal(
  scmPurchaseOrderMatchesListFilters(splitChild, {
    poType: "split",
    dropoff: "3445",
    vendor: "Vendor A",
    pickupPoint: "Vendor Yard"
  }),
  true,
  "The type quick filter must combine with destination, vendor, and pickup filters."
);
assert.equal(
  scmPurchaseOrderMatchesListFilters(splitChild, {
    poType: "split",
    dropoff: "2967",
    vendor: "Vendor A",
    pickupPoint: "Vendor Yard"
  }),
  false,
  "A mismatch in any combined filter must exclude the order."
);
assert.equal(
  scmPurchaseOrderMatchesListFilters(splitChild, {
    poType: "split",
    dropoff: "3445",
    vendor: "Different Vendor",
    pickupPoint: "Vendor Yard"
  }),
  false,
  "The vendor filter must still constrain a Split PO quick-filter result."
);
assert.equal(
  scmPurchaseOrderMatchesListFilters(splitChild, {
    poType: "split",
    dropoff: "3445",
    vendor: "Vendor A",
    pickupPoint: "Different Yard"
  }),
  false,
  "The pickup filter must still constrain a Split PO quick-filter result."
);
assert.equal(
  scmPurchaseOrderMatchesListFilters(parent, {
    search: "po100",
    poType: "split",
    dropoff: "2967",
    vendor: "Different Vendor",
    pickupPoint: "Different Yard"
  }),
  true,
  "After the upstream global search matches, every UI filter must be ignored."
);
assert.equal(
  scmPurchaseOrderMatchesListFilters(vrma, { search: "vrma100" }),
  false,
  "VRMA must remain excluded even during global search."
);

const publicUrl = new URL("../public/", import.meta.url);
const client = fs.readFileSync(new URL("dispatch-scm.js", publicUrl), "utf8");
const page = fs.readFileSync(new URL("dispatch-scm.html", publicUrl), "utf8");
const server = fs.readFileSync(new URL("server.js", import.meta.url), "utf8");
const repository = fs.readFileSync(new URL("dispatch-repository.js", import.meta.url), "utf8");

assert.match(client, /let scmPoTypeFilter = "";/);
assert.match(client, /params\.set\("poType", scmPoTypeFilter\)/);
assert.match(client, /data-action="filter-po-type" data-value="po"/);
assert.match(client, /data-action="filter-po-type" data-value="split"/);
assert.match(client, /scmPoTypeFilter = scmPoTypeFilter === nextType \? "" : nextType/);
assert.match(server, /poType: req\.query\.poType \|\| ""/);
assert.match(page, /dispatch-scm\.js\?v=20260813-po-split-status-v3/);
assert.match(repository, /FROM dispatch_scm_po_splits s[\s\S]*?WHERE s\.status = 'active'/);
assert.match(repository, /const splitByRef = new Map\(splitRows\.rows\.map/);
assert.match(repository, /isScmSplit: true/);
assert.match(repository, /let orders = listedOrders\.filter\(\(order\) => scmPurchaseOrderListKind\(order\) !== "vrma"\)/);

console.log(JSON.stringify({
  ok: true,
  sourceAndNeverSplitArePo: true,
  splitLedgerChildIsSplitPo: true,
  vrmaExcluded: true,
  filtersCombine: true,
  globalSearchBypassesFilters: true
}));
