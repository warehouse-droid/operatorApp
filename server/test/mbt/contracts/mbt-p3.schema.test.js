import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../../../contracts/mbt-p3.schema.json", import.meta.url);

const FRONT_VISIT_ID = "00000000-0000-4000-8000-000000000801";
const FUTURE_VISIT_ID = "00000000-0000-4000-8000-000000000802";

const VALID_FRONT_LEG = Object.freeze({
  schemaVersion: "mbt-bin-dispatch-feed-v1",
  planDate: "2037-08-03",
  items: [{
    id: "BIN-MBT-P3-0001-V1",
    type: "BIN",
    serviceAction: "delivery",
    customer: "Synthetic Pilot Customer",
    address: "100 Test Route, Toronto, ON",
    scheduledWindow: {
      startAt: "2037-08-03T12:00:00.000Z",
      endAt: "2037-08-03T16:00:00.000Z"
    },
    stops: [
      {
        id: "BIN-MBT-P3-0001-V1-S1",
        sequence: 1,
        type: "pickup",
        actionCode: "collect_empty_bin",
        locationRole: "origin_yard",
        yardId: "00000000-0000-4000-8000-000000012441",
        yardCode: "12441",
        siteProfileId: null,
        evidenceRequirements: [{ code: "outgoing_bin_scan", type: "bin_scan", minimumCount: 1 }]
      },
      {
        id: "BIN-MBT-P3-0001-V1-S2",
        sequence: 2,
        type: "drop",
        actionCode: "deliver_bin",
        locationRole: "customer_site",
        yardId: null,
        yardCode: null,
        siteProfileId: "00000000-0000-4000-8000-000000000803",
        evidenceRequirements: [{ code: "placement_photo", type: "photo", minimumCount: 1 }]
      }
    ],
    mbt: {
      snapshotVersion: 1,
      contractId: "00000000-0000-4000-8000-000000000804",
      contractNumber: "MBT-P3-0001",
      visitId: FRONT_VISIT_ID,
      visitReference: "BIN-MBT-P3-0001-V1",
      visitNumber: 1,
      visitRevision: 1,
      status: "ready",
      frontLeg: {
        predecessorVisitId: null,
        predecessorTerminal: true,
        dispatchable: true
      },
      templateVersionId: "00000000-0000-4000-8000-000000000805",
      templateRevision: 2,
      binTypeId: "00000000-0000-4000-8000-000000000014",
      binTypeCode: "14YD",
      assetRequirements: [{
        reservationSlot: "outgoing",
        exactAssetId: "00000000-0000-4000-8000-000000000806",
        exactAssetCode: "P3-BIN-0001",
        expectedStateRevision: 1
      }],
      truckRequirements: {
        truckType: "bin",
        minimumSlots: 1,
        supportedBinTypeCode: "14YD"
      },
      sharedYards: [{
        role: "origin",
        yardId: "00000000-0000-4000-8000-000000012441",
        yardCode: "12441",
        dispatchLocationId: 15
      }],
      timeline: [
        {
          visitId: FRONT_VISIT_ID,
          visitNumber: 1,
          serviceAction: "delivery",
          status: "ready",
          relation: "current",
          locked: false
        },
        {
          visitId: FUTURE_VISIT_ID,
          visitNumber: 2,
          serviceAction: "return_bin",
          status: "tentative",
          relation: "future",
          locked: true
        }
      ]
    }
  }]
});

async function validator() {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/binDispatchFeed`);
  assert.equal(typeof validate, "function", "P3.8 requires the versioned BIN dispatch-feed schema.");
  return validate;
}

test("P3-F15 contract: the v1 BIN feed accepts one complete current front-leg snapshot", async () => {
  const validate = await validator();
  assert.equal(validate(structuredClone(VALID_FRONT_LEG)), true, JSON.stringify(validate.errors));
});

test("P3-F15/F16 contract: an unbound delivery exposes bounded exact-asset choices without weakening bound cards", async () => {
  const validate = await validator();
  const unbound = structuredClone(VALID_FRONT_LEG);
  unbound.items[0].mbt.assetRequirements = [];
  unbound.items[0].mbt.assetChoices = [{
    reservationSlot: "outgoing",
    eligibleAssets: [
      {
        assetId: "00000000-0000-4000-8000-000000000807",
        assetCode: "P3-BIN-0002",
        stateRevision: 3
      },
      {
        assetId: "00000000-0000-4000-8000-000000000806",
        assetCode: "P3-BIN-0001",
        stateRevision: 1
      }
    ]
  }];

  assert.equal(validate(unbound), true, JSON.stringify(validate.errors));
  assert.equal(validate(structuredClone(VALID_FRONT_LEG)), true, JSON.stringify(validate.errors));

  for (const mutate of [
    (feed) => { feed.items[0].mbt.assetChoices[0].reservationSlot = ""; },
    (feed) => { feed.items[0].mbt.assetChoices[0].eligibleAssets[0].stateRevision = 0; },
    (feed) => { feed.items[0].mbt.assetChoices[0].eligibleAssets[0].assetId = "not-an-asset"; }
  ]) {
    const candidate = structuredClone(unbound);
    mutate(candidate);
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  }
});

test("P3-F15 contract: incomplete identity, capability, timeline, and mandatory stops fail closed", async () => {
  const validate = await validator();
  const mutations = [
    (feed) => delete feed.items[0].mbt.visitRevision,
    (feed) => delete feed.items[0].mbt.frontLeg,
    (feed) => delete feed.items[0].mbt.truckRequirements,
    (feed) => delete feed.items[0].mbt.sharedYards,
    (feed) => delete feed.items[0].mbt.timeline,
    (feed) => { feed.items[0].stops = []; },
    (feed) => { feed.items[0].stops[1].sequence = 0; },
    (feed) => { feed.items[0].stops.push(structuredClone(feed.items[0].stops[0])); }
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(VALID_FRONT_LEG);
    mutate(candidate);
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  }
});

test("P3-F15/F16 contract: future/whole/split/legacy-order identities cannot impersonate one BIN leg", async () => {
  const validate = await validator();
  const invalid = [];

  const future = structuredClone(VALID_FRONT_LEG);
  future.items[0].mbt.visitId = FUTURE_VISIT_ID;
  future.items[0].mbt.visitNumber = 2;
  future.items[0].mbt.status = "tentative";
  future.items[0].mbt.frontLeg = {
    predecessorVisitId: FRONT_VISIT_ID,
    predecessorTerminal: false,
    dispatchable: false
  };
  invalid.push(future);

  const wholeContract = structuredClone(VALID_FRONT_LEG);
  wholeContract.items[0].mbt.visitId = null;
  wholeContract.items[0].mbt.contractVisits = [FRONT_VISIT_ID, FUTURE_VISIT_ID];
  invalid.push(wholeContract);

  const split = structuredClone(VALID_FRONT_LEG);
  split.items[0].mbt.assignment = {
    loadId: "LOAD-A",
    secondaryLoadId: "LOAD-B"
  };
  invalid.push(split);

  const legacy = structuredClone(VALID_FRONT_LEG);
  legacy.items[0].type = "SO";
  legacy.items[0].mbt.fulfillment = { status: "pending" };
  invalid.push(legacy);

  for (const candidate of invalid) {
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  }
});
