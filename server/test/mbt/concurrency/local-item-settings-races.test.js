import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  listMbtLocalItemSettings,
  updateMbtLocalItemSetting
} from "../../../src/mbt/local-item-settings-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `local-item-race-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const RACE_REPETITIONS = 25;
let identitySequence = 0;

function current40Yd(items) {
  const item = items.find(({ itemCode }) => itemCode === "40YD");
  assert.ok(item);
  return item;
}

function command(item, marker) {
  identitySequence += 1;
  const identity = `${RUN_ID}-${identitySequence}`;
  return {
    actor: ACTOR,
    itemCode: item.itemCode,
    setting: {
      displayName: `40 yard race ${marker}`,
      description: `Independent race ${marker}`,
      active: true
    },
    expectedRevision: item.revision,
    reason: `Concurrent local item update ${marker}`,
    idempotencyKey: `local-race-idem-${identity}`,
    correlationId: `local-race-corr-${identity}`,
    requestId: `local-race-req-${identity}`
  };
}

after(async () => {
  await closeDb();
});

test("LC05: 25 two-client races produce one revision winner and one stale loser each", {
  timeout: 120_000
}, async () => {
  let current = current40Yd(await listMbtLocalItemSettings());
  const startingRevision = current.revision;
  const startingEvidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.local_item.updated') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.local_item.update') AS receipts`,
    [ACTOR.operatorId]
  );

  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const commands = [
      command(current, `${iteration}-left`),
      command(current, `${iteration}-right`)
    ];
    const outcomes = await Promise.allSettled(
      commands.map((input) => updateMbtLocalItemSetting(input))
    );
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.ok(
      losers[0].reason instanceof MbtError
        && losers[0].reason.status === 409
        && losers[0].reason.code === "MBT_STALE_REVISION"
    );
    current = current40Yd(await listMbtLocalItemSettings());
    assert.equal(current.revision, startingRevision + iteration + 1);
    assert.equal(current.displayName, winners[0].value.body.item.displayName);
  }

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.local_item.updated') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.local_item.update') AS receipts`,
    [ACTOR.operatorId]
  );
  assert.deepEqual(evidence.rows[0], {
    audits: startingEvidence.rows[0].audits + RACE_REPETITIONS,
    receipts: startingEvidence.rows[0].receipts + RACE_REPETITIONS
  });
});
