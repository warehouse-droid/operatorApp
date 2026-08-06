import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../../src/mbt/shadow-billing-service.js", import.meta.url),
  "utf8"
);

test("multi-bin billing resolves bin size, pricing, and rental dates from the bound service line", () => {
  const start = source.indexOf("async function selectedBillingCase");
  const end = source.indexOf("function assertLocalMbtCase", start);
  assert.ok(start >= 0 && end > start);
  const selected = source.slice(start, end);
  assert.match(selected, /JOIN\s+mbt_service_visits\s+visit/iu);
  assert.match(selected, /LEFT JOIN\s+mbt_contract_service_lines\s+service_line/iu);
  assert.match(selected, /COALESCE\(service_line\.bin_type_id,\s*contract\.bin_type_id\)/iu);
  assert.match(selected, /COALESCE\(service_line\.pricing_snapshot,\s*contract\.pricing_snapshot\)/iu);
  assert.match(selected, /COALESCE\(service_line\.planned_return_at,\s*contract\.planned_return_at\)/iu);
});
