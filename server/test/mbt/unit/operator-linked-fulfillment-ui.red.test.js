import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const operator = await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8");

test("L3/L4 Operator keeps fully linked and blocked lines visible but non-confirmable", () => {
  assert.match(operator, /line\.no_yard_load_required\s*\|\|\s*line\.linked_quantity_blocked/u);
  assert.match(operator, /function renderLinkedSupplyBreakdown/u);
  assert.match(operator, /No yard load required/u);
  assert.match(operator, /Linked quantity exceeds Dispatch target/u);
  assert.match(operator, /Operator residual/u);
  assert.match(operator, /if \(line\.no_yard_load_required \|\| line\.linked_quantity_blocked\)/u);
});
