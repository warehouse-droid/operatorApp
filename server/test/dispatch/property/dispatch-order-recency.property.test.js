import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchOrderRecency,
  dispatchOrderSourceDate
} from "../../../src/dispatch-order-recency.js";

const EPOCH = "1970-01-01T00:00:00.000Z";

test("first arrival takes precedence over transaction dates and every later sync", () => {
  for (const firstSeen of ["2026-09-29T23:15:10.500Z", new Date("2026-09-29T23:15:10.500Z")]) {
    const order = { firstSeenAt: firstSeen, sourceOrderDate: "2020-01-01", updatedAt: "2099-01-01", syncedAt: "2098-01-01" };
    assert.equal(dispatchOrderRecency(order), "2026-09-29T23:15:10.500Z");
  }
  assert.equal(dispatchOrderRecency({ raw: { first_seen_at: "2026-09-30T00:15:10.500+02:00" }, sourceOrderDate: "2020-01-01" }), "2026-09-29T22:15:10.500Z");
});

test("derived cards inherit arrival time even when transaction dates run in the opposite order", () => {
  const older = { type: "TO", firstSeenAt: "2026-09-01T12:00:00Z", sourceOrderDate: "2026-09-30" };
  const newer = { type: "TO", firstSeenAt: "2026-09-29T14:35:16Z", sourceOrderDate: "2020-01-01" };
  const group = { type: "TO", isGrouped: true, childOrderDetails: [older, { type: "TO", isGrouped: true, childOrderDetails: [newer] }] };
  assert.equal(dispatchOrderRecency(group), "2026-09-29T14:35:16.000Z");
  assert.equal(dispatchOrderRecency({ ...group, childOrderDetails: [...group.childOrderDetails].reverse() }), "2026-09-29T14:35:16.000Z");
  assert.equal(dispatchOrderRecency({ ...newer, isSplit: true, updatedAt: "2099-01-01" }), "2026-09-29T14:35:16.000Z");
  assert.equal(dispatchOrderRecency({ type: "CO", sourceTable: "local_co_orders", sourceOrderId: "GO-X", createdAt: "2026-09-01T12:00:00Z", childOrderDetails: [newer] }), "2026-09-01T12:00:00.000Z");
});

test("original transaction dates take precedence over activity and planned delivery dates", () => {
  const order = {
    id: "TOB01164", type: "TO", sourceOrderDate: "2026-09-29",
    expectedDeliveryDate: "2035-01-01", deliveryDate: "2035-02-01",
    updatedAt: "2030-01-01T00:00:00Z", syncedAt: "2031-01-01T00:00:00Z",
    scm: { updatedAt: "2032-01-01T00:00:00Z", etaDate: "2035-03-01" },
    raw: { source_order_date: "2020-01-01" }
  };
  assert.equal(dispatchOrderSourceDate(order), "2026-09-29T00:00:00.000Z");
  assert.equal(dispatchOrderRecency(order), "2026-09-29T00:00:00.000Z");
  assert.equal(dispatchOrderSourceDate({ raw: { source_order_date: "2026-09-28" } }), "2026-09-28T00:00:00.000Z");
});

test("local CO and custom recency follows creation instead of later edits", () => {
  for (const order of [
    { id: "CO-TOB01164", type: "CO", sourceTable: "local_co_orders" },
    { id: "CUSTOM-RECENCY", type: "CUSTOM", sourceTable: "dispatch_custom_orders" }
  ]) {
    Object.assign(order, { createdAt: "2026-09-29T14:35:16Z", updatedAt: "2030-01-01T00:00:00Z" });
    assert.equal(dispatchOrderSourceDate(order), "2026-09-29T14:35:16.000Z");
    assert.equal(dispatchOrderRecency(order), "2026-09-29T14:35:16.000Z");
  }
  const wrapper = {
    id: "CO-GO-RECENCY", type: "CO", sourceTable: "local_co_orders",
    sourceOrderId: "GO-RECENCY", isGrouped: true,
    createdAt: "2026-09-01T12:00:00Z",
    childOrders: ["TO-RECENCY"],
    childOrderDetails: [{ id: "TO-RECENCY", type: "TO", sourceOrderDate: "2026-09-29" }]
  };
  assert.equal(dispatchOrderSourceDate(wrapper), "2026-09-01T12:00:00.000Z",
    "Informational source children must not turn an existing CO into a newly created CO.");
});

test("global groups inherit the newest constituent date through nested groups", () => {
  const newest = { id: "SO-NEW", type: "SO", sourceOrderDate: "2026-09-29" };
  const group = {
    id: "GO-OUTER", type: "SO", isGrouped: true, globalGroupDefinition: true,
    sourceOrderDate: "2026-01-01", updatedAt: "2035-01-01T00:00:00Z",
    childOrders: ["SO-OLD", "GO-INNER"],
    childOrderDetails: [
      { id: "SO-OLD", type: "SO", sourceOrderDate: "2026-09-01", updatedAt: "2040-01-01T00:00:00Z" },
      { id: "GO-INNER", type: "SO", isGrouped: true, childOrders: [newest.id], childOrderDetails: [newest] }
    ]
  };
  assert.equal(dispatchOrderSourceDate(group), "2026-09-29T00:00:00.000Z");
  assert.equal(dispatchOrderRecency(group), "2026-09-29T00:00:00.000Z");
  const coGroup = {
    id: "GO-COS", type: "CO", isGrouped: true, childOrders: ["CO-OLD", "CO-NEW"],
    childOrderDetails: [
      { id: "CO-OLD", type: "CO", sourceTable: "local_co_orders", createdAt: "2026-09-01T12:00:00Z" },
      { id: "CO-NEW", type: "CO", sourceTable: "local_co_orders", createdAt: "2026-09-29T14:35:16Z" }
    ]
  };
  assert.equal(dispatchOrderSourceDate(coGroup), "2026-09-29T14:35:16.000Z");
});

test("a split keeps its inherited parent transaction date when its definition changes", () => {
  const split = {
    id: "TOB01164-S1", type: "TO", originalOrderId: "TOB01164", isSplit: true,
    globalOrderDefinition: true, sourceOrderDate: "2026-09-29",
    updatedAt: "2030-01-01T00:00:00Z", expectedDeliveryDate: "2031-01-01"
  };
  assert.equal(dispatchOrderRecency(split), "2026-09-29T00:00:00.000Z");
});

test("invalid original dates are rejected without throwing or using delivery estimates", () => {
  for (const value of [null, undefined, "", "not-a-date", "2026-02-30", "2026-13-01", "2026-09-00", new Date(NaN)]) {
    const order = { sourceOrderDate: value, expectedDeliveryDate: "2030-01-01" };
    assert.equal(dispatchOrderSourceDate(order), null, String(value));
    assert.equal(dispatchOrderRecency(order), EPOCH, String(value));
    assert.equal(dispatchOrderRecency({ ...order, updatedAt: "2026-09-30T01:02:03Z" }), "2026-09-30T01:02:03.000Z");
  }
  assert.equal(dispatchOrderSourceDate({ expectedDeliveryDate: "2030-01-01", scm: { etaDate: "2030-02-01" } }), null);
});

test("missing original dates retain activity aliases and epoch fallback", () => {
  const expected = "2026-09-30T01:02:03.000Z";
  for (const activity of [
    { updatedAt: expected }, { updated_at: expected },
    { syncedAt: expected }, { synced_at: expected }, { scm: { updatedAt: expected } }
  ]) {
    assert.equal(dispatchOrderSourceDate(activity), null);
    assert.equal(dispatchOrderRecency(activity), expected);
  }
  assert.equal(dispatchOrderRecency({}), EPOCH);
  assert.equal(dispatchOrderRecency({ updatedAt: "invalid" }), EPOCH);
  assert.equal(dispatchOrderRecency({ updatedAt: "2026-09-01", syncedAt: "2026-09-29" }), "2026-09-01T00:00:00.000Z");
});

test("valid Date objects and timezone timestamps normalize consistently without mutation", () => {
  const original = new Date("2026-09-29T23:15:10.500Z");
  const order = Object.freeze({ sourceOrderDate: original });
  assert.equal(dispatchOrderSourceDate(order), original.toISOString());
  assert.equal(dispatchOrderRecency(order), original.toISOString());
  assert.equal(original.toISOString(), "2026-09-29T23:15:10.500Z");
  assert.equal(dispatchOrderSourceDate({ sourceOrderDate: "2026-09-30T00:15:10.500+02:00" }), "2026-09-29T22:15:10.500Z");
  assert.equal(dispatchOrderSourceDate({ createdAt: new Date("2026-09-29T14:35:16Z") }), "2026-09-29T14:35:16.000Z");
});

test("deterministic generated orders retain recency under identifier, ETA, and activity changes", () => {
  let state = 20260930;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let index = 0; index < 160; index++) {
    const date = new Date(Date.UTC(2020 + next() % 8, next() % 12, 1 + next() % 28));
    const original = date.toISOString();
    const day = original.slice(0, 10);
    const base = { id: `TO-${next()}`, type: "TO", sourceOrderDate: day };
    const changed = {
      ...base, id: `ZZZ-${next()}`, expectedDeliveryDate: "2099-12-31",
      updatedAt: "2098-01-01T00:00:00Z", syncedAt: "2097-01-01T00:00:00Z",
      scm: { updatedAt: "2096-01-01T00:00:00Z", etaDate: "2099-01-01" }
    };
    assert.equal(dispatchOrderSourceDate(base), original);
    assert.equal(dispatchOrderRecency(changed), original);
    const childDate = new Date(date.getTime() + (1 + next() % 90) * 86_400_000).toISOString();
    const children = [base, { id: `TO-CHILD-${index}`, type: "TO", sourceOrderDate: childDate }];
    const group = { id: `GO-${index}`, type: "TO", isGrouped: true, childOrderDetails: children };
    assert.equal(dispatchOrderRecency(group), childDate);
    assert.equal(dispatchOrderRecency({ ...group, childOrderDetails: [...children].reverse() }), childDate);
  }
});
