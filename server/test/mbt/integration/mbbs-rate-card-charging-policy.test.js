// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  activateLocalRateCardVersion,
  applyLocalRateCardDraft,
  cloneLocalRateCardVersion,
  deleteLocalRateCard,
  getLocalRateCardGraph,
  replaceLocalRateCardDraft,
  validateLocalRateCardVersion
} from "../../../src/mbt/rate-card-configuration-service.js";
import {
  DEFAULT_MBBS_RATE_CARD_POLICY,
  MBBS_RATE_CARD_POLICY_RULES
} from "../../../src/mbt/mbbs-rate-card-policy.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({
  operatorId: `mbbs-policy-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
let sequence = 0;

after(closeDb);

function command(label, extra = {}) {
  sequence += 1;
  const identity = `${RUN_ID}-${sequence}`;
  return {
    actor: ACTOR,
    reason: `MBBS policy ${label}`,
    idempotencyKey: `mbbs-policy-idem-${identity}`,
    correlationId: `mbbs-policy-corr-${identity}`,
    requestId: `mbbs-policy-req-${identity}`,
    ...extra
  };
}

function policy(directPickupUnitAmountMinor, poAdditionalDropUnitAmountMinor) {
  return {
    schemaVersion: 1,
    currency: "CAD",
    directPickupUnitAmountMinor,
    poAdditionalDropUnitAmountMinor,
    ...MBBS_RATE_CARD_POLICY_RULES
  };
}

function graph({
  suffix = "BASE",
  versionNumber = 1,
  effectiveFrom = "2026-01-01T00:00:00.000Z",
  directPickupUnitAmountMinor = 12_345,
  poAdditionalDropUnitAmountMinor = 4_567
} = {}) {
  return {
    rateCard: {
      rateCardCode: `MBBS_POLICY_${RUN_ID.slice(0, 12)}_${suffix}`,
      displayName: `MBBS charging policy ${suffix}`,
      description: "Versioned MBBS SO, TO, and PO charging policy",
      itemCode: null,
      customerNetSuiteId: null,
      subsidiaryNetSuiteId: null,
      serviceTemplateCode: null,
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber,
      effectiveFrom,
      effectiveTo: null,
      defaultRentalCalendarDays: 14,
      calculationNotes: "MBBS charging policy lifecycle integration test"
    },
    distanceBands: [{
      itemCode: "DELIVERY_CHARGE_MBBS",
      serviceCode: "mbbs_cross_charge",
      binTypeCode: null,
      sequenceNumber: 0,
      minimumMetres: 0,
      maximumMetres: null,
      amountMinor: 20_000,
      pricingBasis: "flat",
      boundaryRule: "upper_inclusive",
      originYardCodes: [],
      downtownSurchargeMinor: 0,
      currency: "CAD",
      description: "Open MBBS cross-charge distance band"
    }],
    components: [],
    dumpTariffs: [],
    depositRules: [],
    mbbsChargingPolicy: policy(
      directPickupUnitAmountMinor,
      poAdditionalDropUnitAmountMinor
    )
  };
}

async function withMasterDataEnabled(operation) {
  const previous = {
    root: config.mbt.enabled,
    masterData: config.mbtPhase3.masterDataEnabled
  };
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  try {
    return await operation();
  } finally {
    config.mbt.enabled = previous.root;
    config.mbtPhase3.masterDataEnabled = previous.masterData;
  }
}

async function ensureMbbsItem() {
  await query(
    `INSERT INTO mbt_local_item_settings (
       item_code, display_name, description, item_type, category,
       pricing_mode, netsuite_mapping_local_key, system_owned,
       applicable_service_types, applicable_legacy_source_types,
       charge_basis, active, revision, created_by, updated_by
     ) VALUES (
       'DELIVERY_CHARGE_MBBS', 'Delivery Charge MBBS',
       'Local MBBS delivery cross-charge.', 'delivery_fee', 'cross_charge',
       'rate_card', 'delivery_charge_mbbs', false,
       ARRAY['delivery']::text[], ARRAY['SO','TO','PO','VRMA']::text[],
       'distance', true, 1, $1, $1
     ) ON CONFLICT (item_code) DO UPDATE SET
         active = true,
         revision = mbt_local_item_settings.revision + 1,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       WHERE NOT mbt_local_item_settings.active`,
    [ACTOR.operatorId]
  );
}

test("versioned MBBS prices can change on a draft and survive clone while active policy remains immutable", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(() => withMasterDataEnabled(async () => {
      await ensureMbbsItem();
      const initialGraph = graph();
      const created = await applyLocalRateCardDraft(command("create", {
        sourceKind: "manual",
        graph: initialGraph
      }));
      const sourceId = created.body.version.rateCardVersionId;
      assert.equal(created.body.version.revision, 1);

      const createdDetail = await getLocalRateCardGraph(sourceId);
      assert.deepEqual(createdDetail.graph.mbbsChargingPolicy, policy(12_345, 4_567));
      const createdPolicy = await query(
        `SELECT direct_pickup_unit_amount_minor::text AS direct,
                po_additional_drop_unit_amount_minor::text AS po_drop,
                revision::int, created_by, updated_by
           FROM mbt_mbbs_rate_card_policies
          WHERE rate_card_version_id = $1`,
        [sourceId]
      );
      assert.deepEqual(createdPolicy.rows[0], {
        direct: "12345",
        po_drop: "4567",
        revision: 1,
        created_by: ACTOR.operatorId,
        updated_by: ACTOR.operatorId
      });

      const changedGraph = structuredClone(initialGraph);
      changedGraph.mbbsChargingPolicy = policy(13_579, 2_468);
      const changed = await replaceLocalRateCardDraft(command("change unused draft prices", {
        rateCardVersionId: sourceId,
        expectedRevision: 1,
        sourceKind: "manual",
        graph: changedGraph
      }));
      assert.equal(changed.body.version.revision, 2);
      assert.deepEqual(
        (await getLocalRateCardGraph(sourceId)).graph.mbbsChargingPolicy,
        policy(13_579, 2_468)
      );

      await assert.rejects(
        replaceLocalRateCardDraft(command("reject stale price overwrite", {
          rateCardVersionId: sourceId,
          expectedRevision: 1,
          sourceKind: "manual",
          graph: initialGraph
        })),
        (error) => error?.code === "MBT_STALE_REVISION" && error?.status === 409
      );

      const validated = await validateLocalRateCardVersion(command("validate", {
        rateCardVersionId: sourceId,
        expectedRevision: changed.body.version.revision
      }));
      const activated = await activateLocalRateCardVersion(command("activate", {
        rateCardVersionId: sourceId,
        expectedRevision: validated.body.version.revision
      }));
      assert.equal(activated.body.version.status, "active");

      assert.deepEqual(
        (await getLocalRateCardGraph(sourceId)).graph.mbbsChargingPolicy,
        policy(13_579, 2_468)
      );

      const cloned = await cloneLocalRateCardVersion(command("clone for future price change", {
        sourceRateCardVersionId: sourceId,
        expectedRevision: activated.body.version.revision
      }));
      const cloneId = cloned.body.version.rateCardVersionId;
      const cloneDetail = await getLocalRateCardGraph(cloneId);
      assert.equal(cloneDetail.version.editable, true);
      assert.deepEqual(cloneDetail.graph.mbbsChargingPolicy, policy(13_579, 2_468));

      const futureGraph = structuredClone(cloneDetail.graph);
      futureGraph.version.effectiveFrom = "2027-01-01T00:00:00.000Z";
      futureGraph.mbbsChargingPolicy = policy(15_000, 7_500);
      const future = await replaceLocalRateCardDraft(command("set future prices", {
        rateCardVersionId: cloneId,
        expectedRevision: cloneDetail.version.revision,
        sourceKind: "manual",
        graph: futureGraph
      }));
      assert.equal(future.body.version.revision, 2);
      assert.deepEqual(
        (await getLocalRateCardGraph(cloneId)).graph.mbbsChargingPolicy,
        policy(15_000, 7_500)
      );
      assert.deepEqual(
        (await getLocalRateCardGraph(sourceId)).graph.mbbsChargingPolicy,
        policy(13_579, 2_468),
        "changing a cloned future draft must not rewrite the active source policy"
      );
      await assert.rejects(
        query(
          `UPDATE mbt_mbbs_rate_card_policies
              SET direct_pickup_unit_amount_minor = 1
            WHERE rate_card_version_id = $1`,
          [sourceId]
        ),
        (error) => error?.code === "55000"
      );
    }));
  } finally {
    await rollback.rollback();
  }
});

test("legacy MBBS bands receive an explicit CAD 100 policy row before activation", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await ensureMbbsItem();
      const rateCardId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      await query(
        `INSERT INTO mbt_rate_cards (
           rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
         ) VALUES ($1, $2, 'Legacy MBBS policy fixture', 'CAD', $3, $3)`,
        [rateCardId, `LEGACY_MBBS_${RUN_ID.slice(0, 12)}`, ACTOR.operatorId]
      );
      await query(
        `INSERT INTO mbt_rate_card_versions (
           rate_card_version_id, rate_card_id, version_number, status,
           effective_from, validation_snapshot, created_by, updated_by
         ) VALUES ($1, $2, 1, 'draft', now(), '{}'::jsonb, $3, $3)`,
        [versionId, rateCardId, ACTOR.operatorId]
      );
      await query(
        `INSERT INTO mbt_rate_distance_bands (
           rate_distance_band_id, rate_card_version_id, item_code, service_code,
           sequence_number, minimum_metres, maximum_metres, amount_minor,
           pricing_basis, boundary_rule, origin_yard_codes, currency, description
         ) VALUES (
           $1, $2, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge',
           0, 0, NULL, 20000, 'flat', 'upper_inclusive', ARRAY[]::text[],
           'CAD', 'Legacy fixture'
         )`,
        [crypto.randomUUID(), versionId]
      );
      const stored = await query(
        `SELECT direct_pickup_unit_amount_minor::int AS direct,
                po_additional_drop_unit_amount_minor::int AS po_drop
           FROM mbt_mbbs_rate_card_policies
          WHERE rate_card_version_id = $1`,
        [versionId]
      );
      assert.deepEqual(stored.rows[0], {
        direct: DEFAULT_MBBS_RATE_CARD_POLICY.directPickupUnitAmountMinor,
        po_drop: DEFAULT_MBBS_RATE_CARD_POLICY.poAdditionalDropUnitAmountMinor
      });
      await query(
        `UPDATE mbt_rate_card_versions
            SET status = 'active', activated_at = now(), updated_by = $2,
                updated_at = now(), revision = revision + 1
          WHERE rate_card_version_id = $1`,
        [versionId, ACTOR.operatorId]
      );
      await assert.rejects(
        query(
          "DELETE FROM mbt_mbbs_rate_card_policies WHERE rate_card_version_id = $1",
          [versionId]
        ),
        (error) => error?.code === "55000"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("an unused MBBS draft deletes its policy and complete rate graph atomically", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(() => withMasterDataEnabled(async () => {
      await ensureMbbsItem();
      const created = await applyLocalRateCardDraft(command("create deletable draft", {
        sourceKind: "manual",
        graph: graph({ suffix: "DELETE" })
      }));
      const versionId = created.body.version.rateCardVersionId;
      const deleted = await deleteLocalRateCard({
        actor: ACTOR,
        rateCardVersionId: versionId,
        expectedRevision: created.body.version.cardRevision,
        idempotencyKey: `mbbs-policy-delete-${RUN_ID}-${sequence}`,
        correlationId: `mbbs-policy-delete-corr-${RUN_ID}-${sequence}`,
        requestId: `mbbs-policy-delete-req-${RUN_ID}-${sequence}`
      });
      assert.equal(deleted.body.deleted, true);
      const retained = await query(
        `SELECT
           (SELECT count(*)::int FROM mbt_rate_card_versions
             WHERE rate_card_version_id = $1) AS versions,
           (SELECT count(*)::int FROM mbt_mbbs_rate_card_policies
             WHERE rate_card_version_id = $1) AS policies`,
        [versionId]
      );
      assert.deepEqual(retained.rows[0], { versions: 0, policies: 0 });
    }));
  } finally {
    await rollback.rollback();
  }
});
