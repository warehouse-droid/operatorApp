import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  listMbtLocalItemSettings,
  updateMbtLocalItemSetting
} from "../../../src/mbt/local-item-settings-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `local-item-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
let commandSequence = 0;

function command(itemCode, expectedRevision, setting, label = "update") {
  commandSequence += 1;
  return {
    actor: ACTOR,
    itemCode,
    setting,
    expectedRevision,
    reason: `Local item ${label}`,
    idempotencyKey: `local-item-${RUN_ID}-${commandSequence}`,
    correlationId: `local-item-corr-${RUN_ID}-${commandSequence}`,
    requestId: `local-item-req-${RUN_ID}-${commandSequence}`
  };
}

function editable(item, overrides = {}) {
  return {
    displayName: item.displayName,
    description: item.description,
    active: item.active,
    ...overrides
  };
}

function itemByCode(items, itemCode) {
  const found = items.find((item) => item.itemCode === itemCode);
  assert.ok(found, `Missing local item ${itemCode}`);
  return found;
}

after(async () => {
  await closeDb();
});

test("LC01/LC02: current migrations retain five protected NetSuite-independent local items", async () => {
  const items = await listMbtLocalItemSettings();
  const protectedItems = items.filter((item) => item.systemOwned);
  assert.deepEqual(protectedItems.map((item) => item.itemCode), [
    "DELIVERY_CROSS_CHARGE",
    "14YD",
    "20YD",
    "40YD",
    "DUMP"
  ]);
  assert.deepEqual(protectedItems.map((item) => ({
    itemCode: item.itemCode,
    itemType: item.itemType,
    rentalPeriodDays: item.rentalPeriodDays,
    category: item.category,
    priceMode: item.priceMode,
    sourceTypes: item.applicableSourceTypes,
    binTypeCode: item.binTypeCode,
    mappingLocalKey: item.netSuiteMappingLocalKey,
    localReady: item.localReady,
    active: item.active
  })), [
    {
      itemCode: "DELIVERY_CROSS_CHARGE",
      itemType: "delivery_fee",
      rentalPeriodDays: null,
      category: "cross_charge",
      priceMode: "rate_card",
      sourceTypes: ["SO", "TO", "PO", "VRMA"],
      binTypeCode: null,
      mappingLocalKey: "delivery_charge",
      localReady: true,
      active: true
    },
    {
      itemCode: "14YD",
      itemType: "bin",
      rentalPeriodDays: 14,
      category: "bin_charge",
      priceMode: "rental_item",
      sourceTypes: [],
      binTypeCode: "14YD",
      mappingLocalKey: "bin_14yd",
      localReady: true,
      active: true
    },
    {
      itemCode: "20YD",
      itemType: "bin",
      rentalPeriodDays: 14,
      category: "bin_charge",
      priceMode: "rental_item",
      sourceTypes: [],
      binTypeCode: "20YD",
      mappingLocalKey: "bin_20yd",
      localReady: true,
      active: true
    },
    {
      itemCode: "40YD",
      itemType: "bin",
      rentalPeriodDays: 14,
      category: "bin_charge",
      priceMode: "rental_item",
      sourceTypes: [],
      binTypeCode: "40YD",
      mappingLocalKey: "bin_40yd",
      localReady: true,
      active: true
    },
    {
      itemCode: "DUMP",
      itemType: "dump",
      rentalPeriodDays: null,
      category: "dump",
      priceMode: "rate_card",
      sourceTypes: [],
      binTypeCode: null,
      mappingLocalKey: null,
      localReady: true,
      active: true
    }
  ]);
  assert.ok(items.every(({ revision }) => Number.isSafeInteger(revision) && revision >= 1));
  assert.equal(items.some(({ itemCode }) => itemCode === "30YD"), false);

  const externalDependencies = await query(
    `SELECT count(*)::int AS dependencies
       FROM mbt_local_item_settings s
       LEFT JOIN mbt_netsuite_mappings m
         ON m.mapping_type = 'sales_order_item'
        AND m.local_key = s.item_code
      WHERE m.mapping_id IS NOT NULL`
  );
  assert.deepEqual(externalDependencies.rows[0], { dependencies: 0 });
});

test("LC05/LC06: an item update is revisioned, audited, and exactly replayable", async () => {
  const before = itemByCode(await listMbtLocalItemSettings(), "DELIVERY_CROSS_CHARGE");
  const input = command(
    before.itemCode,
    before.revision,
    editable(before, {
      displayName: `Local delivery charge ${RUN_ID}`,
      description: "Calculated locally from the approved cross-charge rate."
    }),
    "calculated delivery update"
  );
  const first = await updateMbtLocalItemSetting(input);
  const replay = await updateMbtLocalItemSetting({ ...input });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(first.body.item.revision, before.revision + 1);
  assert.equal(first.body.item.priceMode, "rate_card");
  assert.equal(first.body.item.netSuiteMappingLocalKey, "delivery_charge");

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'mbt.local_item.updated'
           AND entity_id = $2
           AND idempotency_key = $3) AS audits,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = 'mbt.local_item.update'
           AND idempotency_key = $3) AS receipts`,
    [ACTOR.operatorId, before.itemCode, input.idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], { audits: 1, receipts: 1 });

  await assert.rejects(
    () => updateMbtLocalItemSetting(command(
      before.itemCode,
      before.revision,
      editable(first.body.item, { displayName: "Stale overwrite" }),
      "stale overwrite"
    )),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_STALE_REVISION"
  );
  assert.equal(
    itemByCode(await listMbtLocalItemSettings(), before.itemCode).displayName,
    first.body.item.displayName
  );
});

test("LC03-R1/LC04: local presentation updates while pricing and identity fields fail without evidence", async () => {
  const before = itemByCode(await listMbtLocalItemSettings(), "14YD");
  const result = await updateMbtLocalItemSetting(command(
    before.itemCode,
    before.revision,
    editable(before, {
      displayName: "14 yard bin charge",
      description: "Fixed 14-day rental and extension price come from the approved local rate card."
    }),
    "local presentation"
  ));
  assert.equal(result.body.item.description, "Fixed 14-day rental and extension price come from the approved local rate card.");
  assert.equal(result.body.item.priceMode, "rental_item");

  const calculated = itemByCode(await listMbtLocalItemSettings(), "DELIVERY_CROSS_CHARGE");
  await assert.rejects(
    () => updateMbtLocalItemSetting(command(
      calculated.itemCode,
      calculated.revision,
      { ...editable(calculated), defaultUnitAmountMinor: 1 },
      "forbidden duplicate price"
    )),
    (error) => error instanceof MbtError
      && error.status === 400
      && error.code === "MBT_LOCAL_ITEM_INPUT_INVALID"
  );
  await assert.rejects(
    () => updateMbtLocalItemSetting(command(
      "UNKNOWN",
      1,
      editable(before),
      "unknown item"
    )),
    (error) => error instanceof MbtError
      && error.status === 404
      && error.code === "MBT_LOCAL_ITEM_NOT_FOUND"
  );
});

test("LC04: database constraints preserve local identity and pricing policy", async () => {
  await assert.rejects(
    () => query(
      "UPDATE mbt_local_item_settings SET category = 'dump' WHERE item_code = '14YD'"
    ),
    (error) => error?.code === "55000"
  );
  await assert.rejects(
    () => query(
      "UPDATE mbt_local_item_settings SET pricing_mode = 'custom_price' WHERE item_code = 'DUMP'"
    ),
    (error) => error?.code === "55000"
  );
  await assert.rejects(
    () => query(
      "UPDATE mbt_local_item_settings SET applicable_source_types = ARRAY['SO']::text[] WHERE item_code = 'DELIVERY_CROSS_CHARGE'"
    ),
    // Source applicability is derived from the frozen server policy and is
    // intentionally absent from the editable persistence table.
    (error) => error?.code === "42703"
  );
});
