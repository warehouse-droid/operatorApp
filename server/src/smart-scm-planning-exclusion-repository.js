import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";

const MAX_REASON_LENGTH = 1000;
const MAX_NOTE_LENGTH = 1000;
const PLANNING_TIME_ZONE = "America/Toronto";

function text(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, message) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error(message), { status: 400 });
  }
  return parsed;
}

function boundedText(value, { name, maximum, required = false } = {}) {
  const resolved = text(value);
  if (required && !resolved) throw Object.assign(new Error(`${name} is required.`), { status: 400 });
  if (resolved.length > maximum) {
    throw Object.assign(new Error(`${name} must be ${maximum} characters or fewer.`), { status: 400 });
  }
  return resolved || null;
}

function zonedParts(date, timeZone = PLANNING_TIME_ZONE) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function zonedMidnightUtc(year, month, day, timeZone = PLANNING_TIME_ZONE) {
  const wallClockUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = wallClockUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = zonedParts(new Date(candidate), timeZone);
    const representedUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    candidate += wallClockUtc - representedUtc;
  }
  return new Date(candidate);
}

function endOfTorontoBusinessDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const selected = new Date(Date.UTC(year, month - 1, day));
  if (selected.getUTCFullYear() !== year || selected.getUTCMonth() + 1 !== month || selected.getUTCDate() !== day) {
    throw Object.assign(new Error("Expiry must be a valid date and time."), { status: 400 });
  }
  const following = new Date(selected.getTime() + 86400000);
  return zonedMidnightUtc(
    following.getUTCFullYear(), following.getUTCMonth() + 1, following.getUTCDate()
  );
}

export function normalizeSmartScmPlanningExclusionExpiry(value) {
  if (value === undefined || value === null || text(value) === "") return null;
  const parsed = endOfTorontoBusinessDate(value) || new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw Object.assign(new Error("Expiry must be a valid date and time."), { status: 400 });
  }
  if (parsed.getTime() <= Date.now()) {
    throw Object.assign(new Error("Expiry must be in the future."), { status: 400 });
  }
  return parsed.toISOString();
}

function expiryThroughDate(value) {
  if (!value) return null;
  const expiry = new Date(value);
  if (!Number.isFinite(expiry.getTime())) return null;
  const finalActiveInstant = new Date(expiry.getTime() - 1);
  const parts = zonedParts(finalActiveInstant);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function publicExclusion(row) {
  const active = row.active === undefined
    ? row.deactivated_at === null && (row.expires_at === null || new Date(row.expires_at).getTime() > Date.now())
    : Boolean(row.active);
  return {
    id: Number(row.id),
    itemId: Number(row.item_id),
    itemName: row.item_name || "",
    itemDescription: row.item_description || "",
    vendor: row.vendor || "",
    vendorCode: row.vendor_code || "",
    reason: row.reason,
    expiresAt: row.expires_at,
    expiresOn: expiryThroughDate(row.expires_at),
    active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deactivatedBy: row.deactivated_by,
    deactivatedAt: row.deactivated_at,
    deactivationNote: row.deactivation_note
  };
}

const EXCLUSION_SELECT = `SELECT exclusion.*,
       item.item_name,
       item.item_description,
       COALESCE(item.vendor, policy.vendor) AS vendor,
       policy.vendor_code,
       (exclusion.deactivated_at IS NULL
        AND (exclusion.expires_at IS NULL OR exclusion.expires_at > now())) AS active
  FROM scm_smart_planning_exclusions exclusion
  JOIN inventory_items item ON item.item_id = exclusion.item_id
  LEFT JOIN scm_smart_item_policies policy ON policy.item_id = exclusion.item_id`;

export async function listSmartScmPlanningExclusions({
  includeInactive = false,
  search = "",
  limit = 500,
  offset = 0
} = {}) {
  const params = [];
  const clauses = [];
  if (!includeInactive) {
    clauses.push("exclusion.deactivated_at IS NULL");
    clauses.push("(exclusion.expires_at IS NULL OR exclusion.expires_at > now())");
  }
  const searchText = text(search);
  if (searchText) {
    params.push(`%${searchText}%`);
    clauses.push(`(item.item_name ILIKE $${params.length}
      OR item.item_description ILIKE $${params.length}
      OR item.item_id::text ILIKE $${params.length}
      OR COALESCE(item.vendor, policy.vendor, '') ILIKE $${params.length}
      OR exclusion.reason ILIKE $${params.length})`);
  }
  const countResult = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE exclusion.deactivated_at IS NULL
              AND (exclusion.expires_at IS NULL OR exclusion.expires_at > now()))::int AS active_count
       FROM scm_smart_planning_exclusions exclusion
       JOIN inventory_items item ON item.item_id = exclusion.item_id
       LEFT JOIN scm_smart_item_policies policy ON policy.item_id = exclusion.item_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
    params
  );
  params.push(Math.min(1000, Math.max(1, Number(limit) || 500)));
  const limitIndex = params.length;
  params.push(Math.max(0, Number(offset) || 0));
  const result = await query(
    `${EXCLUSION_SELECT}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY active DESC, exclusion.created_at DESC, exclusion.id DESC
      LIMIT $${limitIndex} OFFSET $${params.length}`,
    params
  );
  return {
    items: result.rows.map(publicExclusion),
    total: Number(countResult.rows[0]?.total || 0),
    activeCount: Number(countResult.rows[0]?.active_count || 0)
  };
}

export async function addSmartScmPlanningExclusion(values = {}, operatorId = null) {
  const itemId = positiveInteger(values.itemId, "A valid item ID is required.");
  const reason = boundedText(values.reason, { name: "Reason", maximum: MAX_REASON_LENGTH, required: true });
  const expiresAt = normalizeSmartScmPlanningExclusionExpiry(values.expiresAt);
  const exclusion = await withTransaction(async () => {
    const item = await query(
      `SELECT item.item_id, item.item_name
         FROM inventory_items item
         JOIN scm_smart_item_policies policy ON policy.item_id = item.item_id
        WHERE item.item_id = $1
        FOR UPDATE OF policy`,
      [itemId]
    );
    if (!item.rowCount) {
      throw Object.assign(new Error("This item is not available in the Smart SCM item master."), { status: 404 });
    }
    await query(
      `UPDATE scm_smart_planning_exclusions
          SET deactivated_by = $2,
              deactivated_at = now(),
              deactivation_note = 'Replaced by a newer temporary exclusion'
        WHERE item_id = $1
          AND deactivated_at IS NULL`,
      [itemId, operatorId || null]
    );
    const created = await query(
      `INSERT INTO scm_smart_planning_exclusions (
         item_id, reason, expires_at, created_by
       ) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [itemId, reason, expiresAt, operatorId || null]
    );
    const selected = await query(`${EXCLUSION_SELECT} WHERE exclusion.id = $1`, [created.rows[0].id]);
    const result = publicExclusion(selected.rows[0]);
    await writeAudit({
      actorType: operatorId ? "operator" : "system",
      actorOperatorId: operatorId || null,
      source: "smart_scm",
      action: "smart_scm.planning_exclusion.add",
      details: { exclusionId: result.id, itemId, reason, expiresAt }
    });
    return result;
  });
  return exclusion;
}

export async function deactivateSmartScmPlanningExclusion(exclusionId, values = {}, operatorId = null) {
  const id = positiveInteger(exclusionId, "A valid planning exclusion ID is required.");
  const note = boundedText(values.note, { name: "Removal note", maximum: MAX_NOTE_LENGTH });
  return withTransaction(async () => {
    const existing = await query(
      "SELECT * FROM scm_smart_planning_exclusions WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!existing.rowCount) {
      throw Object.assign(new Error("Temporary planning exclusion was not found."), { status: 404 });
    }
    const changed = existing.rows[0].deactivated_at === null;
    if (changed) {
      await query(
        `UPDATE scm_smart_planning_exclusions
            SET deactivated_by = $2,
                deactivated_at = now(),
                deactivation_note = $3
          WHERE id = $1`,
        [id, operatorId || null, note]
      );
      await writeAudit({
        actorType: operatorId ? "operator" : "system",
        actorOperatorId: operatorId || null,
        source: "smart_scm",
        action: "smart_scm.planning_exclusion.deactivate",
        details: { exclusionId: id, itemId: Number(existing.rows[0].item_id), note }
      });
    }
    const selected = await query(`${EXCLUSION_SELECT} WHERE exclusion.id = $1`, [id]);
    return publicExclusion(selected.rows[0]);
  });
}

export async function listSmartScmActivePlanningExclusionItemIds({ search = "" } = {}) {
  const searchText = text(search);
  const result = await query(
    `SELECT DISTINCT exclusion.item_id
       FROM scm_smart_planning_exclusions exclusion
       JOIN inventory_items item ON item.item_id = exclusion.item_id
       LEFT JOIN scm_smart_item_policies policy ON policy.item_id = exclusion.item_id
      WHERE exclusion.deactivated_at IS NULL
        AND (exclusion.expires_at IS NULL OR exclusion.expires_at > now())
        AND ($1 = '' OR concat_ws(' ', item.item_id::text, item.item_name,
              item.item_description, item.vendor, policy.vendor, policy.vendor_code,
              exclusion.reason) ILIKE '%' || $1 || '%')
      ORDER BY exclusion.item_id`,
    [searchText]
  );
  return result.rows.map((row) => Number(row.item_id)).filter(Number.isInteger);
}
