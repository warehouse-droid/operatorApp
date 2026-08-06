import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import { createAssetFixture } from "../support/asset-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fixture;
let templateVersionId;

async function createTemplateDefinition() {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const templateId = crypto.randomUUID();
  const localTemplateVersionId = crypto.randomUUID();
  const templateStepId = crypto.randomUUID();
  const evidenceRequirementId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_service_templates (
       template_id, template_code, display_name, created_by, updated_by
     ) VALUES ($1, $2, $3, 'visit-foundation-test', 'visit-foundation-test')`,
    [templateId, `p1_template_${suffix}`, `Template ${suffix}`]
  );
  await pool.query(
    `INSERT INTO mbt_service_template_versions (
       template_version_id, template_id, version_number, status,
       created_by, updated_by
     ) VALUES (
       $1, $2, 1, 'draft', 'visit-foundation-test', 'visit-foundation-test'
     )`,
    [localTemplateVersionId, templateId]
  );
  await pool.query(
    `INSERT INTO mbt_service_template_steps (
       template_step_id, template_version_id, sequence_number, action_code,
       display_name, stop_kind, location_role
     ) VALUES ($1, $2, 0, 'deliver_bin', 'Deliver bin', 'customer', 'customer_site')`,
    [templateStepId, localTemplateVersionId]
  );
  await pool.query(
    `INSERT INTO mbt_service_template_evidence_requirements (
       evidence_requirement_id, template_version_id, template_step_id,
       evidence_code, evidence_type, minimum_count, required
     ) VALUES ($1, $2, $3, 'delivery_photo', 'photo', 1, true)`,
    [evidenceRequirementId, localTemplateVersionId, templateStepId]
  );
  return {
    templateId,
    templateVersionId: localTemplateVersionId,
    templateStepId,
    evidenceRequirementId
  };
}

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createAssetFixture(client, { assetCount: 1, visitCount: 2 });
    const mutableTemplateId = crypto.randomUUID();
    templateVersionId = crypto.randomUUID();
    const suffix = mutableTemplateId.replaceAll("-", "");
    await client.query(
      `INSERT INTO mbt_service_templates (
         template_id, template_code, display_name, created_by, updated_by
       ) VALUES ($1, $2, $3, 'visit-foundation-test', 'visit-foundation-test')`,
      [mutableTemplateId, `p1_mutable_${suffix}`, `Mutable template ${suffix}`]
    );
    await client.query(
      `INSERT INTO mbt_service_template_versions (
         template_version_id, template_id, version_number, status,
         created_by, updated_by
       ) VALUES (
         $1, $2, 1, 'draft', 'visit-foundation-test', 'visit-foundation-test'
       )`,
      [templateVersionId, mutableTemplateId]
    );
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

async function insertTemplateStep({ actionCode, sequenceNumber }) {
  const templateStepId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_service_template_steps (
       template_step_id, template_version_id, sequence_number, action_code,
       display_name, stop_kind, location_role
     ) VALUES ($1, $2, $3, $4, $5, 'customer', 'customer_site')`,
    [templateStepId, templateVersionId, sequenceNumber, actionCode, `Step ${actionCode}`]
  );
  return templateStepId;
}

test("F10: template-version steps keep stable action codes and ordering", async () => {
  const prefix = fixture.fixtureId.slice(0, 8);
  const actionCode = `deliver_${prefix}`;
  const templateStepId = await insertTemplateStep({ actionCode, sequenceNumber: 0 });

  await assert.rejects(
    () => insertTemplateStep({ actionCode: `collect_${prefix}`, sequenceNumber: 0 }),
    (error) => error?.code === "23505"
  );
  await assert.rejects(
    () => insertTemplateStep({ actionCode, sequenceNumber: 1 }),
    (error) => error?.code === "23505"
  );

  const retained = await pool.query(
    `SELECT template_step_id, sequence_number, action_code
       FROM mbt_service_template_steps
      WHERE template_version_id = $1`,
    [templateVersionId]
  );
  assert.deepEqual(retained.rows, [{
    template_step_id: templateStepId,
    sequence_number: 0,
    action_code: actionCode
  }]);
});

test("F10: activated template versions, steps, and evidence requirements are immutable", async () => {
  const definition = await createTemplateDefinition();
  await pool.query(
    `UPDATE mbt_service_template_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1
      WHERE template_version_id = $1`,
    [definition.templateVersionId]
  );

  const forbidden = [
    [
      "UPDATE mbt_service_template_versions SET default_rental_calendar_days = 99 WHERE template_version_id = $1",
      [definition.templateVersionId]
    ],
    [
      "DELETE FROM mbt_service_template_versions WHERE template_version_id = $1",
      [definition.templateVersionId]
    ],
    [
      "UPDATE mbt_service_template_steps SET action_code = 'rewritten' WHERE template_step_id = $1",
      [definition.templateStepId]
    ],
    [
      "DELETE FROM mbt_service_template_steps WHERE template_step_id = $1",
      [definition.templateStepId]
    ],
    [
      `INSERT INTO mbt_service_template_steps (
         template_step_id, template_version_id, sequence_number, action_code,
         display_name, stop_kind, location_role
       ) VALUES ($1, $2, 1, 'late_step', 'Late step', 'customer', 'customer_site')`,
      [crypto.randomUUID(), definition.templateVersionId]
    ],
    [
      "UPDATE mbt_service_template_evidence_requirements SET minimum_count = 2 WHERE evidence_requirement_id = $1",
      [definition.evidenceRequirementId]
    ],
    [
      "DELETE FROM mbt_service_template_evidence_requirements WHERE evidence_requirement_id = $1",
      [definition.evidenceRequirementId]
    ],
    [
      `INSERT INTO mbt_service_template_evidence_requirements (
         evidence_requirement_id, template_version_id, evidence_code,
         evidence_type, minimum_count, required
       ) VALUES ($1, $2, 'late_note', 'note', 1, true)`,
      [crypto.randomUUID(), definition.templateVersionId]
    ]
  ];
  for (const [sql, params] of forbidden) {
    await assert.rejects(
      () => pool.query(sql, params),
      (error) => error?.code === "55000"
    );
  }

  const retained = await pool.query(
    `SELECT v.status, v.default_rental_calendar_days,
            s.action_code, r.minimum_count
       FROM mbt_service_template_versions v
       JOIN mbt_service_template_steps s USING (template_version_id)
       JOIN mbt_service_template_evidence_requirements r
         ON r.template_step_id = s.template_step_id
      WHERE v.template_version_id = $1`,
    [definition.templateVersionId]
  );
  assert.deepEqual(retained.rows, [{
    status: "active",
    default_rental_calendar_days: 14,
    action_code: "deliver_bin",
    minimum_count: 1
  }]);
});

test("F10: a used draft template definition is immutable", async () => {
  const definition = await createTemplateDefinition();
  const visitId = crypto.randomUUID();
  const context = await pool.query(
    `SELECT customer_site_profile_id, bin_type_id
       FROM mbt_contracts
      WHERE contract_id = $1`,
    [fixture.contractId]
  );
  await pool.query(
    `INSERT INTO mbt_service_visits (
       service_visit_id, contract_id, visit_number, visit_reference,
       service_template_version_id, service_action, status,
       customer_site_profile_id, bin_type_id,
       customer_snapshot, site_snapshot, service_snapshot,
       created_by, updated_by
     ) VALUES (
       $1, $2, 999, $3, $4, 'draft_definition_test', 'tentative',
       $5, $6, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       'visit-foundation-test', 'visit-foundation-test'
     )`,
    [
      visitId,
      fixture.contractId,
      `P1-V-USED-DRAFT-${visitId}`,
      definition.templateVersionId,
      context.rows[0].customer_site_profile_id,
      context.rows[0].bin_type_id
    ]
  );

  await assert.rejects(
    () => pool.query(
      "UPDATE mbt_service_template_steps SET sequence_number = 7 WHERE template_step_id = $1",
      [definition.templateStepId]
    ),
    (error) => error?.code === "55000"
  );
  await assert.rejects(
    () => pool.query(
      "UPDATE mbt_service_template_versions SET default_rental_calendar_days = 30 WHERE template_version_id = $1",
      [definition.templateVersionId]
    ),
    (error) => error?.code === "55000"
  );
});

test("F10: completed visits reject parent and child history edits, including late inserts", async () => {
  const visitId = fixture.visitIds[1];
  const prefix = fixture.fixtureId.slice(8, 16);
  const templateStepId = fixture.templateStepId;
  const visitStepId = crypto.randomUUID();
  const requirementId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_visit_steps (
       visit_step_id, service_visit_id, template_step_id, sequence_number,
       action_code, display_name, location_role, status, started_at, completed_at
     ) VALUES (
       $1, $2, $3, 10, $4, 'Service bin', 'customer_site', 'completed',
       '2035-01-02T08:00:00.000Z', '2035-01-02T08:30:00.000Z'
     )`,
    [visitStepId, visitId, templateStepId, `service_${prefix}`]
  );
  await pool.query(
    `INSERT INTO mbt_visit_evidence_requirements (
       visit_evidence_requirement_id, service_visit_id, visit_step_id,
       evidence_code, evidence_type, status
     ) VALUES ($1, $2, $3, $4, 'photo', 'satisfied')`,
    [requirementId, visitId, visitStepId, `photo_${prefix}`]
  );
  await pool.query(
    `INSERT INTO mbt_evidence (
       evidence_id, service_visit_id, visit_step_id,
       visit_evidence_requirement_id, evidence_type, storage_provider,
       storage_key, content_sha256, mime_type, size_bytes, captured_at,
       captured_by_type, captured_by_id, source, metadata
     ) VALUES (
       $1, $2, $3, $4, 'photo', 'test-object-store', $5, $6,
       'image/jpeg', 128, '2035-01-02T08:20:00.000Z',
       'driver', 'driver-fixture', 'visit-foundation-test', '{}'::jsonb
     )`,
    [
      evidenceId,
      visitId,
      visitStepId,
      requirementId,
      `visit/${visitId}/${evidenceId}.jpg`,
      "c".repeat(64)
    ]
  );
  await pool.query(
    `UPDATE mbt_service_visits
        SET status = 'completed',
            actual_started_at = '2035-01-02T08:00:00.000Z',
            actual_completed_at = '2035-01-02T08:30:00.000Z',
            revision = revision + 1
      WHERE service_visit_id = $1`,
    [visitId]
  );

  const forbidden = [
    ["UPDATE mbt_service_visits SET updated_by = 'rewrite' WHERE service_visit_id = $1", [visitId]],
    ["DELETE FROM mbt_service_visits WHERE service_visit_id = $1", [visitId]],
    ["UPDATE mbt_visit_steps SET display_name = 'rewrite' WHERE visit_step_id = $1", [visitStepId]],
    ["DELETE FROM mbt_visit_steps WHERE visit_step_id = $1", [visitStepId]],
    ["UPDATE mbt_visit_evidence_requirements SET minimum_count = 2 WHERE visit_evidence_requirement_id = $1", [requirementId]],
    ["DELETE FROM mbt_visit_evidence_requirements WHERE visit_evidence_requirement_id = $1", [requirementId]],
    ["UPDATE mbt_evidence SET metadata = '{\"rewrite\":true}'::jsonb WHERE evidence_id = $1", [evidenceId]],
    ["DELETE FROM mbt_evidence WHERE evidence_id = $1", [evidenceId]],
    [
      `INSERT INTO mbt_visit_steps (
         visit_step_id, service_visit_id, sequence_number, action_code,
         display_name, location_role
       ) VALUES ($1, $2, 11, $3, 'Late step', 'customer_site')`,
      [crypto.randomUUID(), visitId, `late_${prefix}`]
    ],
    [
      `INSERT INTO mbt_visit_evidence_requirements (
         visit_evidence_requirement_id, service_visit_id, evidence_code,
         evidence_type, status
       ) VALUES ($1, $2, $3, 'note', 'pending')`,
      [crypto.randomUUID(), visitId, `late_note_${prefix}`]
    ],
    [
      `INSERT INTO mbt_evidence (
         evidence_id, service_visit_id, evidence_type, storage_provider,
         storage_key, content_sha256, mime_type, size_bytes, captured_at,
         captured_by_type, source
       ) VALUES (
         $1, $2, 'note', 'test-object-store', $3, $4, 'text/plain', 1,
         '2035-01-02T08:31:00.000Z', 'dispatcher', 'visit-foundation-test'
       )`,
      [
        crypto.randomUUID(),
        visitId,
        `visit/${visitId}/late-${crypto.randomUUID()}.txt`,
        "d".repeat(64)
      ]
    ]
  ];

  for (const [sql, params] of forbidden) {
    await assert.rejects(
      () => pool.query(sql, params),
      (error) => error?.code === "55000"
    );
  }

  const retained = await pool.query(
    `SELECT v.status, v.revision::int AS revision,
            s.display_name, r.minimum_count::int AS minimum_count,
            e.metadata
       FROM mbt_service_visits v
       JOIN mbt_visit_steps s ON s.service_visit_id = v.service_visit_id
       JOIN mbt_visit_evidence_requirements r ON r.visit_step_id = s.visit_step_id
       JOIN mbt_evidence e ON e.visit_evidence_requirement_id = r.visit_evidence_requirement_id
      WHERE v.service_visit_id = $1`,
    [visitId]
  );
  assert.deepEqual(retained.rows, [{
    status: "completed",
    revision: 2,
    display_name: "Service bin",
    minimum_count: 1,
    metadata: {}
  }]);
});

test("F10: contract, amendment, and visit states and revisions fail closed", async () => {
  const amendmentId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_contract_amendments (
       amendment_id, contract_id, amendment_number, amendment_type, status,
       reason, before_snapshot, after_snapshot, created_by, updated_by
     ) VALUES (
       $1, $2, 1, 'extension', 'draft', 'Phase 1 state test',
       '{}'::jsonb, '{}'::jsonb, 'mbt-test', 'mbt-test'
     )`,
    [amendmentId, fixture.contractId]
  );

  for (const [sql, params] of [
    ["UPDATE mbt_contracts SET status = 'unknown' WHERE contract_id = $1", [fixture.contractId]],
    ["UPDATE mbt_contracts SET revision = 0 WHERE contract_id = $1", [fixture.contractId]],
    ["UPDATE mbt_contract_amendments SET status = 'unknown' WHERE amendment_id = $1", [amendmentId]],
    ["UPDATE mbt_contract_amendments SET revision = 0 WHERE amendment_id = $1", [amendmentId]],
    ["UPDATE mbt_service_visits SET status = 'unknown' WHERE service_visit_id = $1", [fixture.visitIds[0]]],
    ["UPDATE mbt_service_visits SET revision = 0 WHERE service_visit_id = $1", [fixture.visitIds[0]]]
  ]) {
    await assert.rejects(
      () => pool.query(sql, params),
      (error) => error?.code === "23514"
    );
  }

  await pool.query(
    `UPDATE mbt_contract_amendments
        SET status = 'approved', approved_at = now(), approved_by = 'mbt-test',
            revision = revision + 1
      WHERE amendment_id = $1`,
    [amendmentId]
  );
  for (const sql of [
    "UPDATE mbt_contract_amendments SET reason = 'rewrite' WHERE amendment_id = $1",
    "DELETE FROM mbt_contract_amendments WHERE amendment_id = $1"
  ]) {
    await assert.rejects(
      () => pool.query(sql, [amendmentId]),
      (error) => error?.code === "55000"
    );
  }

  const retained = await pool.query(
    `SELECT c.status AS contract_status, c.revision::int AS contract_revision,
            a.status AS amendment_status, a.revision::int AS amendment_revision,
            v.status AS visit_status, v.revision::int AS visit_revision
       FROM mbt_contracts c
       JOIN mbt_contract_amendments a ON a.contract_id = c.contract_id
       JOIN mbt_service_visits v ON v.contract_id = c.contract_id
      WHERE c.contract_id = $1 AND a.amendment_id = $2 AND v.service_visit_id = $3`,
    [fixture.contractId, amendmentId, fixture.visitIds[0]]
  );
  assert.deepEqual(retained.rows, [{
    contract_status: "active",
    contract_revision: 1,
    amendment_status: "approved",
    amendment_revision: 2,
    visit_status: "ready",
    visit_revision: 1
  }]);
});
