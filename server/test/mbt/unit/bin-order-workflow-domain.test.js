import test from "node:test";
import assert from "node:assert/strict";
import { binOrderReference, buildBinOrderWorkflow, assertBinWorkflowDependency } from "../../../src/mbt/bin-order-workflow-domain.js";

const location = { kind: "yard", id: "yard-1", name: "North Yard", address: "10 Yard Road" };
const site = { kind: "customer_site", id: "site-1", name: "Customer A", address: "20 Site Road" };
const dumpSite = { kind: "dump_site", id: "dump-1", name: "Approved Dump", address: "30 Dump Road" };
const window = { startAt: "2030-07-10T12:00:00Z", endAt: "2030-07-10T20:00:00Z" };
function input(overrides = {}) {
  return { rentalNumber: 1, kind: "exchange", exchangeNumber: 1, sequence: "collection_first",
    reuse: "same_bin", binTypeId: "type-20", deliveryAssetId: "B017", collectionAssetId: "B017",
    site, source: location, dumpSite, materialId: "material-1",
    destination: { kind: "yard", location }, deliveryWindow: window, collectionWindow: window, ...overrides };
}

test("BIN references use the approved rental, exchange and physical-action suffixes", () => {
  const expected = [
    [{kind:"delivery"}, "BIN00001D"],
    [{kind:"collection"}, "BIN00001C"],
    [{kind:"collection", action:"dump"}, "BIN00001C-DP"],
    [{kind:"collection", action:"return"}, "BIN00001-R"],
    [{kind:"exchange", exchangeNumber:1}, "BIN00001X-1"],
    [{kind:"exchange", exchangeNumber:1, action:"delivery"}, "BIN00001X-1D"],
    [{kind:"exchange", exchangeNumber:1, action:"collection"}, "BIN00001X-1C"],
    [{kind:"exchange", exchangeNumber:1, action:"dump"}, "BIN00001X-1DP"],
    [{kind:"exchange", exchangeNumber:1, action:"return"}, "BIN00001X-1R"],
    [{kind:"exchange", exchangeNumber:2, action:"delivery"}, "BIN00001X-2D"],
  ];
  for (const [options, reference] of expected) assert.equal(binOrderReference(1, options), reference);
  assert.equal(binOrderReference(100001, {kind:"delivery"}), "BIN100001D");
  for (const number of [0, -1, 1.2, "undefined", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => binOrderReference(number, {kind:"delivery"}), /number/i);
  }
});

test("same-bin collection-first uses a completed dump dependency and one shared destination delivery", () => {
  const flow = buildBinOrderWorkflow(input());
  assert.equal(flow.reference, "BIN00001X-1");
  assert.deepEqual(flow.parts.map(p => [p.role,p.assetId]), [["delivery","B017"],["collection","B017"]]);
  assert.deepEqual(flow.parts[0].steps.map(s=>s.actionCode), ["deliver_bin"]);
  assert.deepEqual(flow.parts[1].steps.map(s=>s.actionCode), ["pickup_bin","dump_bin"]);
  assert.deepEqual(flow.dependencies, [{part:"delivery",actionCode:"deliver_bin",requiresPart:"collection",requiresActionCode:"dump_bin"}]);
  assert.equal(flow.parts[1].destination.part, "delivery");
  assert.equal(flow.parts[0].source.planned,true);
  assert.equal(flow.sameDay, true);
});

test("different-bin collection-first unlocks delivery after pickup while retaining disposal and return", () => {
  const flow = buildBinOrderWorkflow(input({reuse:"different_bin",deliveryAssetId:"B042"}));
  assert.equal(flow.dependencies[0].requiresActionCode, "pickup_bin");
  assert.deepEqual(flow.parts[1].steps.map(s=>s.reference), ["BIN00001X-1C","BIN00001X-1DP","BIN00001X-1R"]);
  assert.equal(flow.parts[1].assetId, "B017");
  assert.equal(flow.parts[0].assetId, "B042");
});

test("delivery-first allows collection days later and preserves the old asset", () => {
  const flow = buildBinOrderWorkflow(input({sequence:"delivery_first",reuse:"different_bin",deliveryAssetId:"B042",
    collectionWindow:{startAt:"2030-07-14T12:00:00Z",endAt:"2030-07-14T20:00:00Z"}}));
  assert.deepEqual(flow.dependencies, [{part:"collection",actionCode:"pickup_bin",requiresPart:"delivery",requiresActionCode:"deliver_bin"}]);
  assert.equal(flow.sameDay, false);
  assert.equal(flow.parts[1].assetId, "B017");
});

test("collection supplies the receiving rental's Delivery reference without a duplicate return", () => {
  const flow = buildBinOrderWorkflow(input({kind:"collection", destination:{kind:"delivery",visitId:"next-delivery",
    reference:"BIN00002D",binTypeId:"type-20"}}));
  assert.equal(flow.reference, "BIN00001C");
  assert.deepEqual(flow.parts[0].steps.map(s=>s.reference), ["BIN00001C","BIN00001C-DP"]);
  assert.equal(flow.parts[0].destination.reference, "BIN00002D");
  assert.equal(flow.parts[0].destination.visitId, "next-delivery");
});

test("workflow rejects an incompatible reuse destination, missing dump, undefined source and same-bin delivery-first", () => {
  assert.throws(()=>buildBinOrderWorkflow(input({kind:"collection",destination:{kind:"delivery",visitId:"next",
    reference:"BIN00002D",binTypeId:"type-30"}})), /type/i);
  assert.throws(()=>buildBinOrderWorkflow(input({dumpSite:null})), /dump/i);
  assert.throws(()=>buildBinOrderWorkflow(input({kind:"delivery",source:{kind:"yard",address:"undefined"}})), /location/i);
  assert.throws(()=>buildBinOrderWorkflow(input({sequence:"delivery_first"})), /different/i);
  assert.throws(()=>buildBinOrderWorkflow(input({kind:"delivery",deliveryWindow:{startAt:window.endAt,endAt:window.startAt}})),/later finish/i);
  assert.throws(()=>buildBinOrderWorkflow(input({kind:"collection",destination:null})),/destination/i);
});

test("collection-first compares local calendar dates and rejects overnight replacement plans", () => {
  assert.throws(()=>buildBinOrderWorkflow(input({deliveryWindow:{startAt:"2030-07-11T12:00:00Z",endAt:"2030-07-11T15:00:00Z"}})), /same.*day/i);
  const flow = buildBinOrderWorkflow(input({
    collectionWindow:{startAt:"2030-07-11T01:00:00Z",endAt:"2030-07-11T02:00:00Z"},
    deliveryWindow:{startAt:"2030-07-11T02:00:00Z",endAt:"2030-07-11T03:00:00Z"}
  }));
  assert.equal(flow.sameDay, true);
});

test("execution dependency rejects missing evidence and reports rather than loses a late real completion", () => {
  assert.throws(()=>assertBinWorkflowDependency({completedAt:null,occurredAt:"2030-07-10T16:00:00Z"}), /prerequisite/i);
  assert.throws(()=>assertBinWorkflowDependency({completedAt:"2030-07-10T17:00:00Z",occurredAt:"2030-07-10T16:00:00Z"}), /before/i);
  assert.deepEqual(assertBinWorkflowDependency({completedAt:"2030-07-10T16:00:00Z",occurredAt:"2030-07-11T16:00:00Z",sameDay:true}), {late:true});
});
