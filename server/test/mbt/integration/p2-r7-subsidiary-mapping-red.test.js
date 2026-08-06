import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import {
  beginRollbackContext,
  closeDb,
  query
} from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  listNetSuiteMappings,
  putNetSuiteMapping
} from "../../../src/mbt/netsuite-readiness-repository.js";

const SUITE_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `p2-r7-subsidiary-admin-${SUITE_ID}`,
  roles: Object.freeze(["admin"])
});
const CASES = Object.freeze([
  Object.freeze({
    checkCode: "customer_33",
    mapping: Object.freeze({
      externalId: "33",
      externalScriptId: null,
      externalName: "MBT Intercompany Customer",
      externalRecordType: "customer",
      subsidiaryNetSuiteId: 5,
      configuration: Object.freeze({
        expected: Object.freeze({
          entityId: "CUSTOMER-33",
          companyName: "MBT Intercompany Customer",
          currencyId: "1",
          termsId: "2",
          taxItemId: "3",
          creditHold: "OFF"
        }),
        caseInsensitiveFields: Object.freeze([])
      }),
      active: true
    })
  }),
  Object.freeze({
    checkCode: "item_initial_service",
    mapping: Object.freeze({
      externalId: "83",
      externalScriptId: null,
      externalName: "Initial Service",
      externalRecordType: "servicesaleitem",
      subsidiaryNetSuiteId: 5,
      configuration: Object.freeze({
        expected: Object.freeze({}),
        caseInsensitiveFields: Object.freeze([])
      }),
      active: true
    })
  })
]);

let sequence = 0;

function commandIdentity(checkCode) {
  sequence += 1;
  return {
    correlationId: `p2-r7-subsidiary-corr-${checkCode}-${SUITE_ID}-${sequence}`,
    idempotencyKey: `p2-r7-subsidiary-idem-${checkCode}-${SUITE_ID}-${sequence}`,
    requestId: `p2-r7-subsidiary-req-${checkCode}-${SUITE_ID}-${sequence}`
  };
}

async function inRollback(callback) {
  const context = await beginRollbackContext();
  try {
    return await context.run(callback);
  } finally {
    await context.rollback();
  }
}

after(async () => {
  await closeDb();
});

for (const { checkCode, mapping } of CASES) {
  test(`P2-R7 ${checkCode} cannot be saved before the current MBT subsidiary exists`, async () => {
    await inRollback(async () => {
      await query(
        `UPDATE mbt_netsuite_mappings
            SET active = false,
                is_current = false,
                updated_at = clock_timestamp()
          WHERE mapping_type = 'subsidiary'
            AND local_key = 'mbt'
            AND is_current`
      );
      const listed = await listNetSuiteMappings();
      const requirement = listed.requirements.find((candidate) => (
        candidate.checkCode === checkCode
      ));
      assert.ok(requirement);
      assert.equal(requirement.requiresSubsidiaryNetSuiteId, true);
      assert.equal(
        listed.requirements.find(({ checkCode: code }) => code === "mbt_subsidiary")
          ?.currentMapping,
        null
      );

      await assert.rejects(
        () => putNetSuiteMapping({
          actor: ACTOR,
          mappingType: requirement.mappingType,
          localKey: requirement.localKey,
          mapping: structuredClone(mapping),
          expectedRevision: requirement.currentMapping?.revision || 0,
          reason: `Reject ${checkCode} until the current MBT subsidiary is configured.`,
          ...commandIdentity(checkCode)
        }),
        (error) => error instanceof MbtError
          && error.status === 400
          && error.code === "MBT_NETSUITE_MAPPING_SUBSIDIARY_NOT_CONFIGURED"
          && error.message === "Configure the current MBT subsidiary mapping before saving a subsidiary-scoped mapping."
          && error.message.length <= 240
      );
    });
  });
}
