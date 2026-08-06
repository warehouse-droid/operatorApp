import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";

const binDispatch = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/bin-dispatch-service.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

/** @param {string} name */
function requiredOperation(name) {
  const operation = binDispatch[name];
  assert.equal(
    typeof operation,
    "function",
    `P3.8 requires the ${name} current-leg Dispatch operation.`
  );
  return operation;
}

after(async () => {
  await closeDb();
});

test("P3-F15: only one ready current front leg enters the selected-date BIN pool", async () => {
  const listMbtBinFrontLegs = requiredOperation("listMbtBinFrontLegs");
  const fixture = await createBinDispatchFixture({
    label: "front-only",
    planDate: binDispatchPlanDate(10)
  });
  const feed = await listMbtBinFrontLegs({
    planDate: fixture.planDate,
    search: fixture.contractNumber,
    limit: 20
  }, { capability: enabledBinDispatchBoundary });

  assert.equal(feed.schemaVersion, "mbt-bin-dispatch-feed-v1");
  assert.equal(feed.planDate, fixture.planDate);
  assert.equal(feed.items.length, 1);
  const [card] = feed.items;
  assert.deepEqual({
    id: card.id,
    type: card.type,
    contractId: card.mbt.contractId,
    contractNumber: card.mbt.contractNumber,
    visitId: card.mbt.visitId,
    visitNumber: card.mbt.visitNumber,
    visitRevision: card.mbt.visitRevision,
    status: card.mbt.status,
    dispatchable: card.mbt.frontLeg.dispatchable
  }, {
    id: fixture.frontReference,
    type: "BIN",
    contractId: fixture.contractId,
    contractNumber: fixture.contractNumber,
    visitId: fixture.frontVisitId,
    visitNumber: 1,
    visitRevision: 1,
    status: "ready",
    dispatchable: true
  });
  assert.deepEqual(card.stops.map(({ id, sequence, actionCode }) => ({
    id,
    sequence,
    actionCode
  })), fixture.frontStops.map(({ stopId, sequence, actionCode }) => ({
    id: stopId,
    sequence,
    actionCode
  })));
  assert.deepEqual(card.mbt.timeline.map(({ visitId, relation, locked }) => ({
    visitId,
    relation,
    locked
  })), [
    { visitId: fixture.frontVisitId, relation: "current", locked: false },
    { visitId: fixture.successorVisitId, relation: "future", locked: true }
  ]);
  assert.equal(feed.items.some(({ mbt }) => mbt.visitId === fixture.successorVisitId), false);
});

test("P3-F15: search finds the current card through contract/customer/site/action/asset/visit only", async () => {
  const listMbtBinFrontLegs = requiredOperation("listMbtBinFrontLegs");
  const fixture = await createBinDispatchFixture({
    label: "front-search",
    planDate: binDispatchPlanDate(20)
  });
  for (const term of [
    fixture.contractNumber,
    "Synthetic BIN customer",
    "100 Test Route",
    "delivery",
    fixture.assetCode,
    fixture.frontReference
  ]) {
    const feed = await listMbtBinFrontLegs({
      planDate: fixture.planDate,
      search: term,
      limit: 20
    }, { capability: enabledBinDispatchBoundary });
    assert.deepEqual(feed.items.map(({ mbt }) => mbt.visitId), [fixture.frontVisitId]);
  }
  const futureOnly = await listMbtBinFrontLegs({
    planDate: fixture.planDate,
    search: fixture.successorReference,
    limit: 20
  }, { capability: enabledBinDispatchBoundary });
  assert.deepEqual(futureOnly.items, [], "a future visit reference must not create a draggable card");
});

test("P3-F15: planned work leaves the unassigned pool but remains in its read-only contract timeline", async () => {
  const listMbtBinFrontLegs = requiredOperation("listMbtBinFrontLegs");
  const getMbtBinContractTimeline = requiredOperation("getMbtBinContractTimeline");
  const fixture = await createBinDispatchFixture({
    label: "planned-timeline",
    planDate: binDispatchPlanDate(30),
    frontStatus: "planned"
  });
  const feed = await listMbtBinFrontLegs({
    planDate: fixture.planDate,
    limit: 20
  }, { capability: enabledBinDispatchBoundary });
  assert.equal(feed.items.some(({ mbt }) => mbt.contractId === fixture.contractId), false);

  const timeline = await getMbtBinContractTimeline({
    contractId: fixture.contractId
  }, { capability: enabledBinDispatchBoundary });
  assert.equal(timeline.schemaVersion, "mbt-bin-contract-timeline-v1");
  assert.deepEqual(timeline.items.map(({ visitId, status, relation, locked }) => ({
    visitId,
    status,
    relation,
    locked
  })), [
    { visitId: fixture.frontVisitId, status: "planned", relation: "current", locked: true },
    { visitId: fixture.successorVisitId, status: "tentative", relation: "future", locked: true }
  ]);
});

test("P3-F15 invariant: a later visit cannot enter ready while its predecessor is nonterminal", async () => {
  requiredOperation("listMbtBinFrontLegs");
  const fixture = await createBinDispatchFixture({
    label: "later-ready-blocked",
    planDate: binDispatchPlanDate(40)
  });
  await assert.rejects(
    query(
      `UPDATE mbt_service_visits
          SET status = 'ready', revision = revision + 1, updated_at = now()
        WHERE service_visit_id = $1`,
      [fixture.successorVisitId]
    ),
    (error) => error?.code === "23505"
      || error?.code === "23514"
      || error?.code === "55000"
  );
  const statuses = await query(
    `SELECT service_visit_id::text, status
       FROM mbt_service_visits
      WHERE contract_id = $1
      ORDER BY visit_number`,
    [fixture.contractId]
  );
  assert.deepEqual(statuses.rows, [
    { service_visit_id: fixture.frontVisitId, status: "ready" },
    { service_visit_id: fixture.successorVisitId, status: "tentative" }
  ]);
});
