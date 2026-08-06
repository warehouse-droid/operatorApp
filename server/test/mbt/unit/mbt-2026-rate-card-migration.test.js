import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../../migrations/130_mbt_multi_item_quoted_distance_pricing.sql", import.meta.url),
  "utf8"
);
const frontdesk = await readFile(
  new URL("../../../src/mbt/frontdesk-service.js", import.meta.url),
  "utf8"
);

test("migration opens one rate card to many item-owned pricing rows", () => {
  assert.match(migration, /DROP INDEX IF EXISTS idx_mbt_rate_cards_item_unique/u);
  assert.match(migration, /DROP TRIGGER IF EXISTS trg_mbt_rate_distance_bands_owner_item/u);
  assert.match(migration, /UPDATE mbt_rate_cards[\s\S]*SET item_code = NULL/u);
  assert.match(migration, /multiple local items/i);
});

test("migration adds explicit pricing basis, quoted boundary rule, and yard scope", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS pricing_basis text/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS boundary_rule text/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS origin_yard_codes text\[\]/u);
  assert.match(migration, /DELIVERY_CHARGE_MBBS/u);
  assert.match(migration, /pricing_basis = 'per_km'/u);
  assert.match(migration, /amount_minor = 700/u);
  assert.match(migration, /boundary_rule = 'upper_inclusive'/u);
});

test("service templates are retained as an internal workflow implementation detail", () => {
  assert.match(migration, /MBT_INTERNAL_BIN_SERVICE/u);
  assert.match(migration, /deliver_bin/u);
  assert.match(migration, /delivery_photo/u);
  assert.match(migration, /UPDATE mbt_rate_cards[\s\S]*service_template_id/u);
});

test("Front Desk selects multi-item child rates and respects origin-yard scopes", () => {
  assert.doesNotMatch(frontdesk, /JOIN mbt_rate_cards card\s+ON card\.item_code = item\.item_code/u);
  assert.match(frontdesk, /origin_yard_codes/u);
  assert.match(frontdesk, /pricing_basis/u);
  assert.match(frontdesk, /boundary_rule/u);
});
