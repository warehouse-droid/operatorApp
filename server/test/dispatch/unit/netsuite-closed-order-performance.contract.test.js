// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [repository, migration] = await Promise.all([
  readFile(new URL("../../../src/netsuite-closed-order-repository.js", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/187_dispatch_date_switch_lookup_indexes.sql", import.meta.url), "utf8")
]);

test("closed-order family resolution uses indexed typed identities instead of repeated text scans", () => {
  assert.match(repository, /requested_ref,\s*numeric_id/u);
  assert.doesNotMatch(repository, /candidate\.netsuite_id::text/u);
  assert.doesNotMatch(
    repository,
    /JOIN\s+(?:sales_orders|purchase_orders|transfer_orders)\s+candidate[\s\S]{0,260}?\sOR\s/iu,
    "Each identity branch must be independently indexable."
  );
  assert.match(repository, /JOIN\s+sales_orders\s+candidate\s+ON\s+candidate\.netsuite_id\s*=\s+requested\.numeric_id/iu);
  assert.match(repository, /JOIN\s+purchase_orders\s+candidate\s+ON\s+candidate\.netsuite_id\s*=\s+requested\.numeric_id/iu);
  assert.match(repository, /JOIN\s+transfer_orders\s+candidate\s+ON\s+candidate\.netsuite_id\s*=\s+requested\.numeric_id/iu);
});

test("date-switch lookup migration indexes normalized refs and every split-family direction", () => {
  for (const table of ["sales_orders", "purchase_orders", "transfer_orders"]) {
    assert.match(
      migration,
      new RegExp(`ON\\s+${table}\\s*\\(upper\\(btrim\\(tranid\\)\\)\\)`, "iu"),
      `${table}.tranid needs a normalized lookup index.`
    );
  }
  assert.match(migration, /ON\s+purchase_orders\s*\(upper\(btrim\(dispatch_ref\)\)\)/iu);
  for (const kind of ["so", "po", "to"]) {
    assert.match(migration, new RegExp(`dispatch_scm_${kind}_splits[\\s\\S]*source_${kind}_ref`, "iu"));
    assert.match(migration, new RegExp(`dispatch_scm_${kind}_splits[\\s\\S]*split_${kind}_ref`, "iu"));
    assert.match(migration, new RegExp(`dispatch_scm_${kind}_splits[\\s\\S]*split_${kind}_id`, "iu"));
  }
});
