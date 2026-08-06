import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun,
  listNetSuiteMappings,
  putNetSuiteMapping,
  signoffNetSuitePreflightRun
} from "../../../src/mbt/netsuite-readiness-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `p2-race-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const MAPPING_TYPE = "subsidiary";
const LOCAL_KEY = "mbt";
const RACE_REPETITIONS = 25;
const NETSUITE_RUNTIME = Object.freeze({
  adapterKind: "read_only_sandbox",
  accountId: "P2_RACE_SANDBOX",
  environmentName: "sandbox",
  restBaseUrl: "https://p2-race-sandbox-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  directAccessEnabled: true,
  sandboxAccountAllowlist: Object.freeze(["P2_RACE_SANDBOX"]),
  readTimeoutMs: 10_000,
  preflightLeaseSeconds: 30
});
let sequence = 0;

function identity(label) {
  sequence += 1;
  const suffix = `${RUN_ID}-${sequence}`;
  return {
    correlationId: `p2-race-corr-${label}-${suffix}`,
    idempotencyKey: `p2-race-idem-${label}-${suffix}`,
    requestId: `p2-race-req-${label}-${suffix}`
  };
}

function mappingPayload(marker) {
  const numericMarker = 90_000_000 + marker;
  return {
    externalId: String(numericMarker),
    externalScriptId: null,
    externalName: `P2 race subsidiary ${marker}`,
    externalRecordType: "subsidiary",
    subsidiaryNetSuiteId: numericMarker,
    configuration: {
      expected: {
        baseCurrency: "CAD",
        legalName: `P2 race subsidiary ${marker}`
      },
      caseInsensitiveFields: ["baseCurrency"]
    },
    active: true
  };
}

function mappingCommand(marker, expectedRevision, label) {
  return {
    actor: ACTOR,
    mappingType: MAPPING_TYPE,
    localKey: LOCAL_KEY,
    mapping: mappingPayload(marker),
    expectedRevision,
    reason: `P2 independent mapping race ${label}`,
    ...identity(label)
  };
}

async function currentMapping() {
  const listed = await listNetSuiteMappings();
  const requirement = listed.requirements.find(({ checkCode }) => checkCode === "mbt_subsidiary");
  assert.ok(requirement, "The MBT subsidiary catalog entry is required.");
  return requirement.currentMapping;
}

async function ensureMapping() {
  const current = await currentMapping();
  if (current) {
    return current;
  }
  const created = await putNetSuiteMapping(mappingCommand(0, 0, "seed"));
  assert.equal(created.replayed, false);
  assert.equal(created.body.mapping.revision, 1);
  return created.body.mapping;
}

function claimInput(iteration, worker) {
  return {
    ...NETSUITE_RUNTIME,
    requestedBy: ACTOR.operatorId,
    correlationId: `p2-race-preflight-${RUN_ID}-${iteration}-${worker}`,
    leaseOwner: `p2-race-worker-${RUN_ID}-${iteration}-${worker}`,
    leaseSeconds: 30
  };
}

function passingChecks(claim) {
  return claim.requirements.map(({ checkCode }) => ({
    checkCode,
    status: "passed",
    observed: { active: true, race: RUN_ID },
    message: `P2 race fixture verified ${checkCode}.`
  }));
}

async function completePassing(claim) {
  return completeNetSuitePreflightRun({
    preflightRunId: claim.preflightRunId,
    leaseToken: claim.leaseToken,
    checks: passingChecks(claim)
  });
}

after(async () => {
  await closeDb();
});

test("P2-F02: 25 independent mapping races commit exactly one next revision and one audit per race", {
  timeout: 120_000
}, async () => {
  let current = await ensureMapping();
  const startingRevision = current.revision;
  const startingEvidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'mbt.netsuite_mapping.updated') AS audits,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = 'mbt.netsuite_mapping.put') AS receipts`,
    [ACTOR.operatorId]
  );

  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const expectedRevision = current.revision;
    const commands = [
      mappingCommand((iteration * 2) + 1, expectedRevision, `mapping-${iteration}-left`),
      mappingCommand((iteration * 2) + 2, expectedRevision, `mapping-${iteration}-right`)
    ];
    const outcomes = await Promise.allSettled(commands.map((command) => putNetSuiteMapping(command)));
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.ok(
      losers[0].reason instanceof MbtError
        && losers[0].reason.status === 409
        && losers[0].reason.code === "MBT_STALE_REVISION",
      String(losers[0].reason)
    );
    assert.equal(winners[0].value.replayed, false);
    assert.equal(winners[0].value.body.mapping.revision, expectedRevision + 1);
    current = await currentMapping();
    assert.equal(current.revision, expectedRevision + 1);
    assert.equal(
      current.externalId,
      winners[0].value.body.mapping.externalId,
      "The current row must be the winning revision."
    );
  }

  assert.equal(current.revision, startingRevision + RACE_REPETITIONS);
  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_netsuite_mappings
         WHERE mapping_type = $1
           AND local_key = $2
           AND revision > $3) AS revisions,
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE actor_operator_id = $4
           AND action = 'mbt.netsuite_mapping.updated') AS audits,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE actor_operator_id = $4
           AND command_name = 'mbt.netsuite_mapping.put') AS receipts`,
    [MAPPING_TYPE, LOCAL_KEY, startingRevision, ACTOR.operatorId]
  );
  assert.deepEqual(evidence.rows[0], {
    revisions: RACE_REPETITIONS,
    audits: startingEvidence.rows[0].audits + RACE_REPETITIONS,
    receipts: startingEvidence.rows[0].receipts + RACE_REPETITIONS
  });
});

test("P2-F03: 25 independent singleton races allow one preflight claim and reject every competitor", {
  timeout: 120_000
}, async () => {
  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, (_unused, worker) => (
        claimNetSuitePreflightRun(claimInput(iteration, worker))
      ))
    );
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 11, JSON.stringify(outcomes));
    assert.ok(losers.every(({ reason }) => (
      reason instanceof MbtError
        && reason.status === 409
        && reason.code === "MBT_NETSUITE_PREFLIGHT_RUNNING"
    )));
    const winner = winners[0].value;
    assert.equal(winner.recoveredRunId, null);
    const completed = await completePassing(winner);
    assert.equal(completed.status, "passed");
  }

  const persisted = await query(
    `SELECT count(*)::int AS runs,
            count(*) FILTER (WHERE status = 'passed')::int AS passed,
            count(*) FILTER (WHERE status IN ('pending', 'running'))::int AS active
       FROM mbt_netsuite_preflight_runs
      WHERE requested_by = $1
        AND account_id = 'P2_RACE_SANDBOX'`,
    [ACTOR.operatorId]
  );
  assert.deepEqual(persisted.rows[0], {
    runs: RACE_REPETITIONS,
    passed: RACE_REPETITIONS,
    active: 0
  });
});

test("P2-F03: an expired singleton is closed with complete unable-to-verify evidence before replacement", async () => {
  const abandoned = await claimNetSuitePreflightRun(claimInput("stale", "abandoned"));
  await query(
    `UPDATE mbt_netsuite_preflight_runs
        SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE preflight_run_id = $1`,
    [abandoned.preflightRunId]
  );

  const replacement = await claimNetSuitePreflightRun(claimInput("stale", "replacement"));
  assert.equal(replacement.recoveredRunId, abandoned.preflightRunId);
  assert.notEqual(replacement.preflightRunId, abandoned.preflightRunId);

  const recovered = await query(
    `SELECT status, error_code, completed_at,
            required_check_count::int AS required_check_count,
            passed_required_count::int AS passed_required_count,
            failed_required_count::int AS failed_required_count,
            lease_token, lease_owner, lease_expires_at
       FROM mbt_netsuite_preflight_runs
      WHERE preflight_run_id = $1`,
    [abandoned.preflightRunId]
  );
  assert.deepEqual(
    {
      ...recovered.rows[0],
      completed_at: Boolean(recovered.rows[0].completed_at)
    },
    {
      status: "unable_to_verify",
      error_code: "MBT_NETSUITE_PREFLIGHT_LEASE_EXPIRED",
      completed_at: true,
      required_check_count: abandoned.requirements.filter(({ required }) => required).length,
      passed_required_count: 0,
      failed_required_count: abandoned.requirements.filter(({ required }) => required).length,
      lease_token: null,
      lease_owner: null,
      lease_expires_at: null
    }
  );
  const checks = await query(
    `SELECT sequence_number::int, check_type, status, severity, observed_snapshot
       FROM mbt_netsuite_preflight_checks
      WHERE preflight_run_id = $1
      ORDER BY sequence_number`,
    [abandoned.preflightRunId]
  );
  assert.equal(checks.rowCount, abandoned.requirements.length);
  assert.deepEqual(
    checks.rows.map(({ sequence_number: index, check_type: checkCode, status }) => ({
      index,
      checkCode,
      status
    })),
    abandoned.requirements.map(({ checkCode }, index) => ({
      index,
      checkCode,
      status: "unable_to_verify"
    }))
  );
  assert.ok(checks.rows.every(({ observed_snapshot: observed }) => observed === null));

  const completed = await completePassing(replacement);
  assert.equal(completed.status, "passed");
});

test("P2-F03: concurrent terminal submissions persist exactly one complete check set", async () => {
  const claim = await claimNetSuitePreflightRun(claimInput("completion", "winner"));
  const input = {
    preflightRunId: claim.preflightRunId,
    leaseToken: claim.leaseToken,
    checks: passingChecks(claim)
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: 16 }, () => completeNetSuitePreflightRun(input))
  );
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 15, JSON.stringify(outcomes));
  assert.ok(losers.every(({ reason }) => (
    reason instanceof MbtError
      && reason.status === 409
      && reason.code === "MBT_NETSUITE_PREFLIGHT_ALREADY_COMPLETED"
  )));

  const persisted = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_netsuite_preflight_checks
         WHERE preflight_run_id = $1) AS checks,
       (SELECT count(*)::int
          FROM mbt_netsuite_preflight_runs
         WHERE preflight_run_id = $1
           AND status = 'passed') AS terminal_runs`,
    [claim.preflightRunId]
  );
  assert.deepEqual(persisted.rows[0], {
    checks: claim.requirements.length,
    terminal_runs: 1
  });
});

test("P2-F04: concurrent exact signoff retries produce one immutable signoff, command receipt, and audit", async () => {
  const claim = await claimNetSuitePreflightRun(claimInput("signoff", "run"));
  await completePassing(claim);
  const command = {
    actor: ACTOR,
    preflightRunId: claim.preflightRunId,
    reason: "P2 concurrent exact sandbox signoff",
    runtime: NETSUITE_RUNTIME,
    ...identity("signoff-race")
  };
  const outcomes = await Promise.all(
    Array.from({ length: 24 }, () => signoffNetSuitePreflightRun(command))
  );
  assert.equal(outcomes.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === true).length, 23);
  assert.ok(outcomes.every(({ status }) => status === 200));
  assert.equal(new Set(outcomes.map(({ body }) => body.signoff.signoffId)).size, 1);

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_netsuite_preflight_signoffs
         WHERE preflight_run_id = $1) AS signoffs,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE actor_operator_id = $2
           AND command_name = 'mbt.netsuite_preflight.signoff'
           AND idempotency_key = $3) AS receipts,
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE actor_operator_id = $2
           AND action = 'mbt.netsuite_preflight.signed_off'
           AND idempotency_key = $3) AS audits`,
    [claim.preflightRunId, ACTOR.operatorId, command.idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], { signoffs: 1, receipts: 1, audits: 1 });
});
