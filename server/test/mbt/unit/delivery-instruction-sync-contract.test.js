import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const enrichment = read("../../../src/dispatch-enrichment.js");
const sync = read("../../../src/order-sync-repository.js");
const dispatchRepository = read("../../../src/dispatch-repository.js");

test("Sales Order enrichment always emits the lossless memo-derived instruction payload", () => {
  assert.match(enrichment, /deriveMemoDeliveryInstruction/);
  assert.match(enrichment, /dispatch_instruction_details:\s*automaticInstruction/);
  assert.match(enrichment, /dispatch_instruction_parse_version:\s*2/);
  assert.match(enrichment, /dispatch_instruction_parsed_at/);
});

test("NetSuite upsert and explicit reparse persist the structured instruction fields", () => {
  for (const source of [sync, dispatchRepository]) {
    assert.match(source, /dispatch_instruction_details/);
    assert.match(source, /dispatch_instruction_parse_version/);
    assert.match(source, /dispatch_instruction_parsed_at/);
  }
});
