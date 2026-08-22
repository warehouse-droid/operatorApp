#!/usr/bin/env node

import crypto from "node:crypto";

import { closeDb, query, withTransaction } from "../src/db.js";
import {
  DEFAULT_MBBS_RATE_CARD_POLICY_V2
} from "../src/mbt/mbbs-rate-card-policy.js";
import {
  normalizeMbbsVendorRouteRates,
  planMbbsPoVrmaRateSeed
} from "../src/mbt/mbbs-vendor-route-rates.js";
import {
  cloneLocalRateCardVersion,
  getLocalRateCardGraph,
  replaceLocalRateCardDraft
} from "../src/mbt/rate-card-configuration-service.js";

const APPLY_FLAG = "--apply-reviewed-draft";
const RECONCILE_FLAG = "--reconcile-reviewed-draft";
const CONFIRMATION = "CREATE_REVIEWED_MBBS_V3_DRAFT";
const RECONCILE_CONFIRMATION = "RECONCILE_REVIEWED_MBBS_V3_DRAFT";
const EFFECTIVE_FROM = "2026-01-01T05:00:00.000Z";
const ACTOR = Object.freeze({ operatorId: "mbbs-vendor-rate-seed", roles: Object.freeze(["admin"]) });

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function masterData() {
  const [vendorYards, mbbsYards] = await Promise.all([
    query(
      `SELECT vendor.id::int AS "localVendorId",
              vendor.name AS "localVendorName",
              retained.yard AS "vendorYardName",
              retained.address AS "vendorYardAddress"
         FROM dispatch_local_vendors vendor
         JOIN LATERAL (
           SELECT yard.yard, yard.address
             FROM dispatch_vendor_yards yard
            WHERE yard.active
              AND lower(btrim(yard.vendor)) = lower(btrim(vendor.name))
            GROUP BY yard.yard, yard.address
         ) retained ON true
        WHERE vendor.active
        ORDER BY lower(vendor.name), lower(retained.yard), lower(retained.address)`
    ),
    query("SELECT yard_code FROM mbt_yards WHERE active ORDER BY yard_code")
  ]);
  return {
    vendorYards: vendorYards.rows,
    mbbsYards: mbbsYards.rows.map((row) => String(row.yard_code))
  };
}

async function sourceVersion(versionId) {
  if (!versionId) {
    return null;
  }
  const selected = await query(
    `SELECT version.rate_card_version_id::text AS "rateCardVersionId",
            version.version_number::int AS "versionNumber",
            version.revision::int, version.status,
            card.rate_card_code AS "rateCardCode",
            card.display_name AS "displayName",
            card.active AS "cardActive",
            EXISTS (
              SELECT 1 FROM mbt_rate_card_versions sibling
               WHERE sibling.rate_card_id = version.rate_card_id
                 AND sibling.version_number = 3
            ) AS "versionThreeExists"
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card USING (rate_card_id)
      WHERE version.rate_card_version_id = $1::uuid`,
    [versionId]
  );
  return selected.rowCount ? selected.rows[0] : null;
}

async function reviewedDraft(versionId, sourceVersionId) {
  if (!versionId || !sourceVersionId) {
    return null;
  }
  const selected = await query(
    `SELECT draft.rate_card_version_id::text AS "rateCardVersionId",
            draft.version_number::int AS "versionNumber",
            draft.revision::int, draft.status,
            draft.first_used_at AS "firstUsedAt",
            card.rate_card_code AS "rateCardCode",
            card.active AS "cardActive",
            EXISTS (
              SELECT 1
                FROM mbt_rate_card_versions source
               WHERE source.rate_card_version_id = $2::uuid
                 AND source.rate_card_id = draft.rate_card_id
                 AND source.version_number = 2
                 AND source.status = 'active'
            ) AS "sameRateCard"
       FROM mbt_rate_card_versions draft
       JOIN mbt_rate_cards card USING (rate_card_id)
      WHERE draft.rate_card_version_id = $1::uuid`,
    [versionId, sourceVersionId]
  );
  return selected.rowCount ? selected.rows[0] : null;
}

function expectedPriorRows(mapped) {
  return normalizeMbbsVendorRouteRates(mapped.map((row) => {
    if (row.rateName === "Permacon - Cambridge to 150") {
      return { ...row, rateName: "Permacon - Cambridge to BS", displayName: "Permacon - Cambridge to BS" };
    }
    if (row.rateName === "Unilock - Georgetown to 150") {
      return { ...row, rateName: "Unilock - Georgetown to BS", displayName: "Unilock - Georgetown to BS" };
    }
    return row;
  }));
}

function sameRows(left, right) {
  return JSON.stringify(normalizeMbbsVendorRouteRates(left))
    === JSON.stringify(normalizeMbbsVendorRouteRates(right));
}

function commandMetadata(scope) {
  const identity = crypto.randomUUID();
  return {
    idempotencyKey: `${scope}:${identity}`,
    correlationId: `${scope}:correlation:${identity}`,
    requestId: identity
  };
}

function operationMode() {
  const apply = process.argv.includes(APPLY_FLAG);
  const reconcile = process.argv.includes(RECONCILE_FLAG);
  if (apply && reconcile) {
    throw new Error("Select either draft creation or reviewed-draft reconciliation, not both.");
  }
  if (reconcile) {
    return "reconcile_reviewed_draft";
  }
  return apply ? "apply_reviewed_draft" : "dry_run";
}

function assertReviewedSourceAndPlan(source, plan) {
  if (!source || source.versionNumber !== 2 || source.status !== "active" || source.cardActive !== true) {
    throw new Error("--source-version-id must identify the enabled active v2 MBBS rate-card version.");
  }
  if (plan.suppliedCount !== 71 || plan.mapped.length !== 54 || plan.fallback.length !== 17) {
    throw new Error("Current local master data does not match the reviewed 71/54/17 seed decision; no draft was changed.");
  }
}

function assertReconciliationTarget(draft) {
  if (process.env.MBBS_VENDOR_RATE_SEED_CONFIRM !== RECONCILE_CONFIRMATION) {
    throw new Error(`Set MBBS_VENDOR_RATE_SEED_CONFIRM=${RECONCILE_CONFIRMATION} to reconcile the reviewed draft.`);
  }
  if (!draft || draft.versionNumber !== 3 || draft.status !== "draft"
      || draft.firstUsedAt !== null || draft.cardActive !== true || draft.sameRateCard !== true) {
    throw new Error("--draft-version-id must identify the unused v3 draft belonging to the active v2 MBBS rate card.");
  }
}

async function reconcileReviewedDraft({ draft, draftVersionId, plan }) {
  assertReconciliationTarget(draft);
  return withTransaction(async () => {
    const detail = await getLocalRateCardGraph(draftVersionId);
    if (Number(detail.version.revision) !== Number(draft.revision)
        || detail.version.editable !== true
        || !sameRows(detail.graph.mbbsVendorRouteRates, expectedPriorRows(plan.mapped))) {
      throw new Error("The v3 draft no longer matches the exact reviewed pre-clarification graph; no reconciliation was performed.");
    }
    const graph = structuredClone(detail.graph);
    graph.version.calculationNotes = "Reviewed PO/VRMA vendor-yard table: 54 exact pairs; 17 distance-band fallbacks; canonical 150 labels.";
    graph.mbbsVendorRouteRates = plan.mapped;
    return replaceLocalRateCardDraft({
      actor: ACTOR,
      rateCardVersionId: draftVersionId,
      expectedRevision: Number(draft.revision),
      sourceKind: "manual",
      graph,
      reason: "Reconcile latest supplied PO/VRMA table to canonical 150 labels",
      ...commandMetadata("mbbs-vendor-rate-v3-reconcile")
    });
  });
}

function assertDraftCreationTarget(source) {
  if (process.env.MBBS_VENDOR_RATE_SEED_CONFIRM !== CONFIRMATION) {
    throw new Error(`Set MBBS_VENDOR_RATE_SEED_CONFIRM=${CONFIRMATION} to create the reviewed draft.`);
  }
  if (source.versionThreeExists === true) {
    throw new Error("A v3 sibling already exists; this guarded seed is intentionally non-repeatable.");
  }
}

async function createReviewedDraft({ source, sourceVersionId, plan }) {
  assertDraftCreationTarget(source);
  return withTransaction(async () => {
    const detail = await getLocalRateCardGraph(sourceVersionId);
    const sourcePolicy = detail.graph.mbbsChargingPolicy || {};
    const cloned = await cloneLocalRateCardVersion({
      actor: ACTOR,
      sourceRateCardVersionId: sourceVersionId,
      expectedRevision: Number(source.revision),
      reason: "Create reviewed v3 draft for PO and reverse-VRMA vendor-yard rates",
      ...commandMetadata("mbbs-vendor-rate-v3-clone")
    });
    const cloneVersion = cloned.body.version;
    if (Number(cloneVersion.versionNumber) !== 3 || cloneVersion.status !== "draft") {
      throw new Error("The cloned version was not the expected v3 draft; review the rate-card lineage.");
    }
    const graph = structuredClone(detail.graph);
    graph.version.versionNumber = 3;
    graph.version.effectiveFrom = EFFECTIVE_FROM;
    graph.version.effectiveTo = null;
    graph.version.calculationNotes = "Reviewed PO/VRMA vendor-yard table: 54 exact pairs; 17 distance-band fallbacks.";
    graph.mbbsChargingPolicy = {
      ...DEFAULT_MBBS_RATE_CARD_POLICY_V2,
      directPickupUnitAmountMinor: Number(sourcePolicy.directPickupUnitAmountMinor ?? 10_000),
      poVrmaAdditionalStopUnitAmountMinor: Number(
        sourcePolicy.poVrmaAdditionalStopUnitAmountMinor
          ?? sourcePolicy.poAdditionalDropUnitAmountMinor
          ?? 10_000
      )
    };
    graph.mbbsVendorRouteRates = plan.mapped;
    return replaceLocalRateCardDraft({
      actor: ACTOR,
      rateCardVersionId: cloneVersion.rateCardVersionId,
      expectedRevision: Number(cloneVersion.revision),
      sourceKind: "manual",
      graph,
      reason: "Apply reviewed 71-row vendor table with 17 explicit distance fallbacks",
      ...commandMetadata("mbbs-vendor-rate-v3-replace")
    });
  });
}

async function main() {
  const mode = operationMode();
  const sourceVersionId = argument("--source-version-id");
  const draftVersionId = argument("--draft-version-id");
  const masters = await masterData();
  const plan = planMbbsPoVrmaRateSeed(masters);
  const source = await sourceVersion(sourceVersionId);
  const draft = await reviewedDraft(draftVersionId, sourceVersionId);
  const report = {
    schemaVersion: "mbbs-po-vrma-v3-seed-plan-v1",
    mode,
    effectiveFrom: EFFECTIVE_FROM,
    source,
    draft,
    counts: {
      supplied: plan.suppliedCount,
      mapped: plan.mapped.length,
      distanceFallback: plan.fallback.length
    },
    mapped: plan.mapped,
    fallback: plan.fallback,
    activationPerformed: false
  };
  if (mode === "dry_run") {
    output(report);
    return;
  }
  assertReviewedSourceAndPlan(source, plan);
  const replaced = mode === "reconcile_reviewed_draft"
    ? await reconcileReviewedDraft({ draft, draftVersionId, plan })
    : await createReviewedDraft({ source, sourceVersionId, plan });
  output({
    ...report,
    mode: mode === "reconcile_reviewed_draft" ? "reconciled_reviewed_draft" : "created_reviewed_draft",
    draft: replaced.body.version,
    activationPerformed: false
  });
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
