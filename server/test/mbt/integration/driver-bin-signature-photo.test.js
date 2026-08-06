import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { materializeMbtDriverBinJob } from "../../../src/mbt/driver-bin-execution-service.js";
import { createAssignedDriverBinFixture } from "../support/driver-bin-fixtures.js";

after(async () => {
  await closeDb();
});

test("P3-F18 hardening: a required signature photo contributes to the offline photo budget", async () => {
  const fixture = await createAssignedDriverBinFixture("signature-photo-budget");
  const deliver = fixture.jobs[1];
  await query(
    `UPDATE mbt_visit_evidence_requirements
        SET evidence_code = 'site_signature', evidence_type = 'signature',
            minimum_count = 1, required = true, updated_at = now()
      WHERE visit_step_id = (
        SELECT visit_step_id
          FROM mbt_visit_steps
         WHERE service_visit_id = $1::uuid
           AND action_code = 'deliver_bin'
      )`,
    [fixture.frontVisitId]
  );
  const materialized = await materializeMbtDriverBinJob(deliver, {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  assert.equal(materialized.requiredPhotos, 1);
  assert.deepEqual(materialized.mbt.evidenceRequirements.map((requirement) => ({
    evidenceCode: requirement.evidenceCode,
    evidenceType: requirement.evidenceType,
    minimumCount: requirement.minimumCount,
    required: requirement.required
  })), [{
    evidenceCode: "site_signature",
    evidenceType: "signature",
    minimumCount: 1,
    required: true
  }]);
});
