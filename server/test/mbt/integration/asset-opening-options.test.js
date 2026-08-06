import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { getMbtAssetOpeningOptions } from "../../../src/mbt/asset-registry-service.js";

after(async () => {
  await closeDb();
});

test("asset opening options expose active item-bound bins and current locations in stable order", async () => {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const activeTypeId = crypto.randomUUID();
  const inactiveTypeId = crypto.randomUUID();
  const activeYardId = crypto.randomUUID();
  const inactiveYardId = crypto.randomUUID();
  const dispatchLocationBase = Number.parseInt(suffix.slice(0, 6), 16) + 1_000_000;

  try {
    await query(
      `INSERT INTO mbt_bin_types (bin_type_id, type_code, display_name, nominal_yards, active)
       VALUES ($1, $2, 'Zulu test bin', 9, true), ($3, $4, 'Hidden test bin', 8, false)`,
      [activeTypeId, `Z${suffix}`, inactiveTypeId, `X${suffix}`]
    );
    await query(
      `INSERT INTO mbt_yards (
         yard_id, yard_code, dispatch_location_id, display_name, active
       ) VALUES (
         $1, $2, $3, 'Zulu test yard', true
       ), (
         $4, $5, $6, 'Hidden test yard', false
       )`,
      [
        activeYardId,
        `Z${suffix}`,
        dispatchLocationBase,
        inactiveYardId,
        `X${suffix}`,
        dispatchLocationBase + 1
      ]
    );
    const result = await getMbtAssetOpeningOptions();
    assert.equal(result.schemaVersion, "mbt-asset-opening-options-v2");
    assert.ok(result.binItems.length > 0, "configured Bin items should be available");
    assert.deepEqual(
      result.binItems.filter(({ binTypeId }) => [activeTypeId, inactiveTypeId].includes(binTypeId)),
      [],
      "a bare bin type must not be offered until a Bin item is bound to it"
    );
    assert.deepEqual(
      result.currentLocations.filter(({ locationId }) => [activeYardId, inactiveYardId].includes(locationId)),
      [{
        locationKind: "yard",
        locationId: activeYardId,
        locationCode: `Z${suffix}`,
        displayName: "Zulu test yard",
        address: ""
      }]
    );
    assert.deepEqual(result.binItems, [...result.binItems].sort((left, right) => (
      left.displayName.localeCompare(right.displayName) || left.itemCode.localeCompare(right.itemCode)
    )));
    assert.deepEqual(result.currentLocations, [...result.currentLocations].sort((left, right) => (
      left.displayName.localeCompare(right.displayName) || left.locationCode.localeCompare(right.locationCode)
    )));
  } finally {
    await query("DELETE FROM mbt_yards WHERE yard_id = ANY($1::uuid[])", [[activeYardId, inactiveYardId]]);
    await query("DELETE FROM mbt_bin_types WHERE bin_type_id = ANY($1::uuid[])", [[activeTypeId, inactiveTypeId]]);
  }
});
