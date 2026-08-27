import assert from "node:assert/strict";
import test from "node:test";

import {
  scmScheduleRouteOptions,
  scmScheduleVendorYardIntersection
} from "../../../src/scm-schedule-route-options.js";

const ownYards = ["3445", "12441", "2967", "150"];

test("PO route choices come from its vendor mapping and MBBS yards, not visible rows", () => {
  const vendorOptionsByRef = new Map([
    ["pob100", [{ yard: "Ayr" }, { yard: "Milton" }]],
    ["pob200", [{ yard: "Gormley" }]]
  ]);
  const context = { vendorOptionsByRef, groupMembersByRef: new Map(), ownYards };

  assert.deepEqual(
    scmScheduleRouteOptions({ orderKind: "PO", orderRef: "POB100" }, context),
    { pickupOptions: ["Ayr", "Milton"], dropoffOptions: ownYards }
  );
  assert.deepEqual(
    scmScheduleRouteOptions({ orderKind: "PO", orderRef: "POB100" }, context),
    scmScheduleRouteOptions({ orderKind: "PO", orderRef: "POB100", filteredToSingleRow: true }, context)
  );
});

test("grouped PO pickup choices are the intersection of every member vendor", () => {
  assert.deepEqual(
    scmScheduleVendorYardIntersection([
      [{ yard: "Ayr" }, { yard: "Milton" }],
      [{ yard: "Ayr" }, { yard: "milton" }, { yard: "Gormley" }],
      [{ yard: "Milton" }]
    ]),
    ["Milton"]
  );
  assert.deepEqual(scmScheduleVendorYardIntersection([[{ yard: "Ayr" }], []]), []);
});

test("TO routes use only MBBS yards and VRMA remains fixed", () => {
  const context = { vendorOptionsByRef: new Map(), groupMembersByRef: new Map(), ownYards };
  assert.deepEqual(
    scmScheduleRouteOptions({ orderKind: "TO", pickupPoint: "3445", dropoffPoint: "2967" }, context),
    { pickupOptions: ownYards, dropoffOptions: ownYards }
  );
  assert.deepEqual(
    scmScheduleRouteOptions({ orderKind: "VRMA", pickupPoint: "2967", dropoffPoint: "Ayr" }, context),
    { pickupOptions: ["2967"], dropoffOptions: ["Ayr"] }
  );
});

test("route normalization covers snake-case rows, duplicate yards, and non-SCM order kinds", () => {
  const context = {
    vendorOptionsByRef: new Map([
      ["po-snake", ["Milton", { yard: "milton" }, { yard: "Ayr" }, { yard: "" }]]
    ]),
    groupMembersByRef: new Map(),
    ownYards: ["3445", "", "3445", "2967"]
  };
  assert.deepEqual(
    scmScheduleRouteOptions({ order_kind: "PO", order_ref: "PO-SNAKE" }, context),
    { pickupOptions: ["Ayr", "Milton"], dropoffOptions: ["3445", "2967"] }
  );
  assert.deepEqual(
    scmScheduleRouteOptions({ order_kind: "CUSTOM" }, context),
    { pickupOptions: [], dropoffOptions: ["3445", "2967"] }
  );
  assert.deepEqual(scmScheduleVendorYardIntersection([]), []);
  assert.deepEqual(scmScheduleVendorYardIntersection("invalid"), []);
});

test("group pickup resolution handles implicit PGOB refs and rejects missing member mappings", () => {
  const vendorOptionsByRef = new Map([
    ["po-a", [{ yard: "Ayr" }, { yard: "Milton" }]],
    ["po-b", [{ yard: "Milton" }]]
  ]);
  assert.deepEqual(
    scmScheduleRouteOptions(
      { orderKind: "PO", orderRef: "PGOB-PO-A-PO-B" },
      {
        vendorOptionsByRef,
        groupMembersByRef: new Map([["pgob-po-a-po-b", ["PO-A", "PO-B"]]]),
        ownYards
      }
    ).pickupOptions,
    ["Milton"]
  );
  assert.deepEqual(
    scmScheduleRouteOptions(
      { orderKind: "PO", orderRef: "PGOB-PO-A-MISSING" },
      {
        vendorOptionsByRef,
        groupMembersByRef: new Map([["pgob-po-a-missing", ["PO-A", "PO-MISSING"]]]),
        ownYards
      }
    ).pickupOptions,
    []
  );
  assert.deepEqual(
    scmScheduleRouteOptions(
      { orderKind: "PO", orderRef: "PO-A", groupRef: "EMPTY-GROUP" },
      { vendorOptionsByRef, groupMembersByRef: new Map([["empty-group", []]]), ownYards }
    ).pickupOptions,
    ["Ayr", "Milton"]
  );
});
