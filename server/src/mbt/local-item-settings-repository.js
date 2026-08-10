// @ts-check

import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import {
  MBT_LOCAL_ITEM_POLICIES,
  normalizeMbtLocalItemUpdate
} from "./local-item-settings.js";
import { assertExpectedRevision, nextRevision } from "./revisions.js";

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

const POLICY_BY_CODE = new Map(MBT_LOCAL_ITEM_POLICIES.map((policy) => [policy.itemCode, policy]));

const SELECT_FIELDS = `
  s.item_code,
  s.display_name,
  s.description,
  s.item_type,
  s.charge_basis,
  s.density_lbs_per_yard,
  s.rental_period_days,
  s.category,
  s.pricing_mode,
  s.netsuite_mapping_local_key,
  s.system_owned,
  s.applicable_service_types,
  s.applicable_legacy_source_types,
  s.active,
  s.revision,
  s.updated_by,
  b.type_code AS bin_type_code,
  b.nominal_yards::int AS bin_capacity_yards,
  m.mapping_id,
  m.external_id,
  m.external_name,
  m.external_record_type,
  m.active AS mapping_active,
  m.validation_status AS mapping_validation_status,
  m.revision AS mapping_revision`;

/** @param {unknown} value */
function itemCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

/** @param {string} code */
function policyFor(code) {
  const policy = POLICY_BY_CODE.get(code);
  // Custom item identity is stored in the database rather than the protected
  // code-owned catalog. The update contract still permits presentation-only
  // fields, and the locked database read below proves that the item exists.
  return policy || Object.freeze({ itemCode: code });
}

/** @param {Record<string, unknown>} row */
function publicMapping(row) {
  if (row.mapping_id === null || row.mapping_id === undefined) {
    return null;
  }
  return {
    mappingId: String(row.mapping_id),
    externalId: String(row.external_id),
    externalName: String(row.external_name || ""),
    externalRecordType: String(row.external_record_type),
    active: row.mapping_active === true,
    validationStatus: String(row.mapping_validation_status),
    revision: Number(row.mapping_revision)
  };
}

/** @param {unknown} value */
function stringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/** @param {Record<string, unknown> | null} mapping @param {unknown} localKey */
function futureMappingStatus(mapping, localKey) {
  if (localKey === null) {
    return "not_applicable";
  }
  if (mapping === null) {
    return "unconfigured";
  }
  return mapping.active === true && mapping.validationStatus === "valid"
    ? "ready"
    : String(mapping.validationStatus);
}

/** @param {Record<string, unknown>} row */
function publicItem(row) {
  const policy = POLICY_BY_CODE.get(String(row.item_code)) || null;
  const mapping = publicMapping(row);
  const legacySources = stringArray(row.applicable_legacy_source_types);
  const applicableSourceTypes = legacySources.length || !policy
    ? legacySources
    : [...policy.applicableSourceTypes];
  const mappingLocalKey = row.netsuite_mapping_local_key === null
    ? null
    : String(row.netsuite_mapping_local_key);
  return {
    itemCode: String(row.item_code),
    displayName: String(row.display_name),
    description: String(row.description || ""),
    systemOwned: row.system_owned === true,
    itemType: String(row.item_type),
    chargeBasis: String(row.charge_basis),
    densityLbsPerYard: row.density_lbs_per_yard === null ? null : Number(row.density_lbs_per_yard),
    rentalPeriodDays: row.rental_period_days === null ? null : Number(row.rental_period_days),
    category: String(row.category),
    priceMode: String(row.pricing_mode),
    applicableSourceTypes,
    applicableServiceTypes: stringArray(row.applicable_service_types),
    applicableLegacySourceTypes: legacySources,
    binTypeCode: row.bin_type_code === null ? null : String(row.bin_type_code),
    binCapacityYards: row.bin_capacity_yards === null ? null : Number(row.bin_capacity_yards),
    netSuiteMappingLocalKey: mappingLocalKey,
    netSuite: mapping,
    futureNetSuiteStatus: futureMappingStatus(mapping, mappingLocalKey),
    localReady: row.active === true,
    active: row.active === true,
    revision: Number(row.revision),
    updatedBy: row.updated_by === null ? null : String(row.updated_by)
  };
}

/** @param {{code?: string | null, forUpdate?: boolean}} [options] */
async function selectItems({ code = null, forUpdate = false } = {}) {
  const result = await query(
    `SELECT ${SELECT_FIELDS}
       FROM mbt_local_item_settings s
       LEFT JOIN mbt_bin_types b ON b.bin_type_id = s.bin_type_id
       LEFT JOIN mbt_netsuite_mappings m
         ON m.mapping_type = 'sales_order_item'
        AND m.local_key = s.netsuite_mapping_local_key
        AND m.is_current
      ${code === null ? "" : "WHERE s.item_code = $1"}
      ORDER BY CASE s.item_code
        WHEN 'DELIVERY_CROSS_CHARGE' THEN 1
        WHEN '14YD' THEN 2
        WHEN '20YD' THEN 3
        WHEN '40YD' THEN 4
        WHEN 'DUMP' THEN 5
        ELSE 99 END,
        s.item_code
      ${forUpdate ? "FOR UPDATE OF s" : ""}`,
    code === null ? [] : [code]
  );
  return result.rows;
}

/** @returns {Promise<Record<string, unknown>[]>} */
export async function listMbtLocalItemSettings() {
  const rows = await selectItems();
  return rows.map(publicItem);
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.itemCode
 * @param {unknown} input.setting
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {readonly string[]} [input.secretValues]
 */
export async function updateMbtLocalItemSetting({
  actor,
  itemCode: rawItemCode,
  setting: rawSetting,
  expectedRevision,
  reason,
  idempotencyKey,
  correlationId,
  requestId,
  secretValues = []
}) {
  const code = itemCode(rawItemCode);
  const policy = policyFor(code);
  const setting = normalizeMbtLocalItemUpdate(rawSetting, policy);
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason) {
    throw new MbtError({
      status: 400,
      code: "MBT_AUDIT_REASON_REQUIRED",
      message: "A local item audit reason is required."
    });
  }
  const payload = {
    itemCode: code,
    setting,
    expectedRevision,
    reason: normalizedReason
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.local_item.update",
    idempotencyKey,
    payload,
    correlationId,
    requestId,
    secretValues,
    mutation: async () => {
      const selected = await selectItems({ code, forUpdate: true });
      if (selected.length === 0) {
        // The catalog check protects typos while this check protects partial or
        // corrupt deployments where a seed row is absent.
        throw new MbtError({
          status: 404,
          code: "MBT_LOCAL_ITEM_NOT_FOUND",
          message: "The local MBT item setting was not found."
        });
      }
      const before = publicItem(selected[0]);
      const normalizedSetting = normalizeMbtLocalItemUpdate(rawSetting, {
        ...policy,
        itemType: before.itemType
      });
      assertExpectedRevision(Number(before.revision), expectedRevision);
      const revision = nextRevision(Number(before.revision));
      await query(
        `UPDATE mbt_local_item_settings
            SET display_name = $2,
                description = $3,
                active = $4,
                charge_basis = $5,
                revision = $6,
                updated_by = $7,
                updated_at = now()
          WHERE item_code = $1`,
        [
          code,
          normalizedSetting.displayName,
          normalizedSetting.description,
          normalizedSetting.active,
          normalizedSetting.chargeBasis ?? before.chargeBasis,
          revision,
          actor.operatorId
        ]
      );
      const updated = await selectItems({ code });
      const after = publicItem(updated[0]);
      return {
        status: 200,
        body: { item: after },
        audit: {
          action: "mbt.local_item.updated",
          entityType: "mbt_local_item",
          entityId: code,
          beforeState: before,
          afterState: after,
          reason: normalizedReason,
          revisionBefore: Number(before.revision),
          revisionAfter: Number(after.revision)
        }
      };
    }
  });
}
