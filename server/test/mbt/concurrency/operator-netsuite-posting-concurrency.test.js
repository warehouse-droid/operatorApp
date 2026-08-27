// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import { createOrReplayOperatorNetSuitePostingCommand } from "../../../src/operator-netsuite-posting-repository.js";

const RUN_ID = crypto.randomUUID();
let operatorId = "";

function draft(requestId, claim) {
  return buildOperatorNetSuitePostingDraft({
    requestId,
    actorOperatorId: operatorId,
    functionKey: "delivery_prep",
    transactionType: "IF",
    policy: {
      gateKey: "operator_netsuite_delivery_prep_if_3445",
      revision: 1,
      effective: true,
      functionKey: "delivery_prep",
      transactionType: "IF",
      locationId: 1,
      yardCode: "3445"
    },
    photoRefs: [],
    localOrderKeys: [claim],
    localOperation: { kind: "delivery_prep_load", orderId: claim, orderType: "sales_order" },
    targets: [{
      sourceOrderKind: "SO",
      sourceNetSuiteId: 9_800_001,
      sourceOrderRef: "SO-CONCURRENCY",
      selectedLines: [{ orderLine: 1, quantity: 1, location: 1, localOrderKey: claim, localLineId: "line-1" }],
      availableLines: [{ orderLine: 1, location: 1 }]
    }]
  });
}

before(async () => {
  const operator = await createOperator({
    username: `posting-concurrency-${RUN_ID}`,
    displayName: "Posting concurrency",
    password: "posting-concurrency-test",
    role: "operator",
    roles: ["operator"],
    yardLocationIds: [1]
  });
  operatorId = operator.id;
});

after(async () => {
  await closeDb();
});

test("P5 concurrency: 32 identical submissions persist one command and replay the other 31", async () => {
  const requestId = crypto.randomUUID();
  const claim = `delivery_prep:sales_order:${RUN_ID}:same-request`;
  const results = await Promise.all(Array.from({ length: 32 }, () => (
    createOrReplayOperatorNetSuitePostingCommand(draft(requestId, claim))
  )));
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(results.filter((result) => result.replayed).length, 31);
  assert.deepEqual([...new Set(results.map((result) => result.command.id))], [requestId]);
});

test("P5 concurrency: 32 request IDs racing for one order yield one owner", async () => {
  const claim = `delivery_prep:sales_order:${RUN_ID}:one-owner`;
  const settled = await Promise.allSettled(Array.from({ length: 32 }, () => (
    createOrReplayOperatorNetSuitePostingCommand(draft(crypto.randomUUID(), claim))
  )));
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 31);
  assert.ok(rejected.every((result) => result.reason?.code === "OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED"));
  const claims = await query(
    `SELECT count(*)::integer AS count
       FROM operator_netsuite_posting_order_claims
      WHERE local_order_key = $1
        AND active = true`,
    [claim]
  );
  assert.equal(claims.rows[0].count, 1);
});
