import { query } from "./db.js";
import { writeAudit } from "./auth-repository.js";

const YARDS = Object.freeze([
  { locationId: 1, code: "3445" },
  { locationId: 28, code: "2967" },
  { locationId: 15, code: "12441" },
  { locationId: 26, code: "150" }
]);
const YARD_IDS = new Set(YARDS.map((yard) => yard.locationId));
const DEFAULT_STOP_ORDER = Object.freeze([26, 15, 1, 28]);
const SHOP_IDS = Object.freeze([1, 28]);

function text(value) {
  return String(value ?? "").trim();
}

export function smartScmRouteRuleKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function integerList(value, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  return [...new Set(input.map(Number).filter(Number.isInteger))];
}

export function smartScmBuiltInRouteRule(sourceName = "") {
  const sourceKey = smartScmRouteRuleKey(sourceName);
  const isUxbridge = sourceKey.endsWith("uxbridge") || sourceKey.endsWith("uxbrige");
  const isWoodbridge = sourceKey.endsWith("woodbridge") || sourceKey.endsWith("woodbrige");
  const specialOrder = sourceKey === "gormley" || isUxbridge || isWoodbridge
    ? [15, 1, 28, 26]
    : [...DEFAULT_STOP_ORDER];
  return {
    id: null,
    sourceKey,
    sourceName: text(sourceName),
    enabled: true,
    maxDrops: 2,
    stopOrder: specialOrder,
    partialRedirectEnabled: sourceKey === "gormley",
    partialRedirectDestinationIds: [...SHOP_IDS],
    partialRedirectHubLocationId: sourceKey === "gormley" ? 15 : null,
    notes: sourceKey === "gormley"
      ? "Partial direct-shop quantities route through 12441."
      : isUxbridge || isWoodbridge
        ? "150 is the last stop whenever another yard is on the route."
        : "",
    configured: false,
    updatedBy: null,
    updatedAt: null
  };
}

function publicRule(row, sourceName = row?.source_name || "") {
  const fallback = smartScmBuiltInRouteRule(sourceName);
  if (!row) return fallback;
  const stopOrder = integerList(row.stop_order, fallback.stopOrder);
  const completeStopOrder = [...stopOrder.filter((id) => YARD_IDS.has(id))];
  for (const id of DEFAULT_STOP_ORDER) if (!completeStopOrder.includes(id)) completeStopOrder.push(id);
  return {
    id: Number(row.id),
    sourceKey: row.source_key,
    sourceName: row.source_name,
    enabled: Boolean(row.enabled),
    maxDrops: Number(row.max_drops || 2),
    stopOrder: completeStopOrder,
    partialRedirectEnabled: Boolean(row.partial_redirect_enabled),
    partialRedirectDestinationIds: integerList(row.partial_redirect_destination_ids, SHOP_IDS).filter((id) => YARD_IDS.has(id)),
    partialRedirectHubLocationId: row.partial_redirect_hub_location_id === null ? null : Number(row.partial_redirect_hub_location_id),
    notes: row.notes || "",
    configured: true,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
  };
}

export async function listSmartScmRouteRules() {
  const [configured, sources] = await Promise.all([
    query("SELECT * FROM scm_smart_route_rules ORDER BY source_name"),
    query(`SELECT DISTINCT COALESCE(NULLIF(BTRIM(vendor_yard), ''), NULLIF(BTRIM(plant), ''), NULLIF(BTRIM(vendor), '')) AS source_name
             FROM scm_smart_item_policies
            WHERE COALESCE(NULLIF(BTRIM(vendor_yard), ''), NULLIF(BTRIM(plant), ''), NULLIF(BTRIM(vendor), '')) IS NOT NULL
            ORDER BY 1`)
  ]);
  const byKey = new Map(configured.rows.map((row) => [row.source_key, publicRule(row)]));
  for (const source of sources.rows) {
    const sourceName = text(source.source_name);
    const key = smartScmRouteRuleKey(sourceName);
    if (key && !byKey.has(key)) byKey.set(key, smartScmBuiltInRouteRule(sourceName));
  }
  return {
    yards: YARDS,
    rules: [...byKey.values()].sort((left, right) => left.sourceName.localeCompare(right.sourceName))
  };
}

export async function smartScmRouteRuleMap() {
  const result = await query("SELECT * FROM scm_smart_route_rules");
  return new Map(result.rows.map((row) => [row.source_key, publicRule(row)]));
}

export async function getSmartScmRouteRule(sourceName = "") {
  const sourceKey = smartScmRouteRuleKey(sourceName);
  if (!sourceKey) return smartScmBuiltInRouteRule(sourceName);
  const result = await query("SELECT * FROM scm_smart_route_rules WHERE source_key = $1", [sourceKey]);
  return result.rowCount ? publicRule(result.rows[0]) : smartScmBuiltInRouteRule(sourceName);
}

export async function upsertSmartScmRouteRule(values = {}, operatorId = null) {
  const sourceName = text(values.sourceName);
  const sourceKey = smartScmRouteRuleKey(sourceName);
  if (!sourceKey) throw Object.assign(new Error("Source name is required."), { status: 400 });
  const maxDrops = Number(values.maxDrops);
  if (!Number.isInteger(maxDrops) || maxDrops < 1 || maxDrops > 2) {
    throw Object.assign(new Error("Maximum drops must be 1 or 2."), { status: 400 });
  }
  const stopOrder = integerList(values.stopOrder);
  if (stopOrder.length !== YARDS.length || stopOrder.some((id) => !YARD_IDS.has(id))) {
    throw Object.assign(new Error("Stop priority must contain each yard exactly once."), { status: 400 });
  }
  const partialRedirectEnabled = Boolean(values.partialRedirectEnabled);
  const partialRedirectDestinationIds = integerList(values.partialRedirectDestinationIds).filter((id) => YARD_IDS.has(id));
  const partialRedirectHubLocationId = values.partialRedirectHubLocationId === null || values.partialRedirectHubLocationId === ""
    ? null
    : Number(values.partialRedirectHubLocationId);
  if (partialRedirectEnabled && (!partialRedirectDestinationIds.length || !YARD_IDS.has(partialRedirectHubLocationId))) {
    throw Object.assign(new Error("Partial-load redirection needs at least one direct yard and a valid hub yard."), { status: 400 });
  }
  if (partialRedirectEnabled && partialRedirectDestinationIds.includes(partialRedirectHubLocationId)) {
    throw Object.assign(new Error("The redirect hub cannot also be a direct destination."), { status: 400 });
  }
  const result = await query(
    `INSERT INTO scm_smart_route_rules (
       source_key, source_name, enabled, max_drops, stop_order,
       partial_redirect_enabled, partial_redirect_destination_ids,
       partial_redirect_hub_location_id, notes, updated_by
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10)
     ON CONFLICT (source_key) DO UPDATE SET
       source_name = EXCLUDED.source_name,
       enabled = EXCLUDED.enabled,
       max_drops = EXCLUDED.max_drops,
       stop_order = EXCLUDED.stop_order,
       partial_redirect_enabled = EXCLUDED.partial_redirect_enabled,
       partial_redirect_destination_ids = EXCLUDED.partial_redirect_destination_ids,
       partial_redirect_hub_location_id = EXCLUDED.partial_redirect_hub_location_id,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [sourceKey, sourceName, values.enabled !== false, maxDrops, JSON.stringify(stopOrder), partialRedirectEnabled,
      JSON.stringify(partialRedirectDestinationIds), partialRedirectHubLocationId, text(values.notes) || null, operatorId]
  );
  const rule = publicRule(result.rows[0]);
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.route_rule.upsert",
    details: rule
  });
  return rule;
}
