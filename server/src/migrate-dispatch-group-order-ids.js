import { closeDb, query, withTransaction } from "./db.js";

function groupIdFromOrderRefs(orderRefs = []) {
  const parsed = orderRefs
    .map((ref) => String(ref || "").trim().toUpperCase())
    .filter(Boolean)
    .map((id) => {
      const match = id.match(/\b(SO[A-Z]|TO[A-Z]|PO[A-Z])\D*(\d+)/i) || id.match(/^([A-Z]+)[^\d]*(\d+)/);
      if (!match) return { prefix: "GRP", number: id.replace(/\W+/g, "") || "ORDER", sortNumber: Number.MAX_SAFE_INTEGER, sortSuffix: id };
      const sourcePrefix = match[1];
      const groupPrefix = sourcePrefix.length > 1 ? `G${sourcePrefix.slice(1)}` : `G${sourcePrefix}`;
      const splitSuffix = id.slice((match.index || 0) + match[0].length).match(/-S\d+/i)?.[0]?.replace(/\W+/g, "") || "";
      const sortNumber = Number.parseInt(match[2], 10) || 0;
      return {
        prefix: groupPrefix,
        number: `${String(sortNumber)}${splitSuffix}`,
        sortNumber,
        sortSuffix: splitSuffix
      };
    })
    .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.sortNumber - b.sortNumber || a.sortSuffix.localeCompare(b.sortSuffix) || a.number.localeCompare(b.number));
  if (!parsed.length) return "";
  const prefixes = [...new Set(parsed.map((item) => item.prefix).filter(Boolean))];
  const prefix = prefixes.length === 1 ? prefixes[0] : `G${prefixes.map((item) => item.replace(/^G/i, "")).join("")}`;
  return `${prefix}-${parsed.map((item) => item.number).join("-")}`;
}

function collectGroupMappingsFromOrders(orders = [], mappings = new Map()) {
  for (const order of orders || []) {
    const id = String(order?.id || "").trim();
    const childOrders = Array.isArray(order?.childOrders) ? order.childOrders : [];
    if (/^(?:GRP|G[A-Z]+)-/i.test(id) && childOrders.length) {
      const nextId = groupIdFromOrderRefs(childOrders);
      if (nextId && nextId !== id && !new RegExp(`^${escapeRegExp(nextId)}-V\\d+$`, "i").test(id)) mappings.set(id, nextId);
    }
    collectGroupMappingsFromOrders(order?.childOrderDetails || [], mappings);
  }
  return mappings;
}

function collectGroupMappingsFromCoRows(rows = [], mappings = new Map()) {
  for (const row of rows || []) {
    const details = row.details || {};
    const oldGroupId = String(row.source_order_ref || details.sourceOrderId || "").trim();
    const childOrderIds = Array.isArray(details.childOrderIds) ? details.childOrderIds : [];
    if (/^(?:GRP|G[A-Z]+)-/i.test(oldGroupId) && childOrderIds.length) {
      const nextId = groupIdFromOrderRefs(childOrderIds);
      if (nextId && nextId !== oldGroupId && !new RegExp(`^${escapeRegExp(nextId)}-V\\d+$`, "i").test(oldGroupId)) mappings.set(oldGroupId, nextId);
    }
  }
  return mappings;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLegacyRefs(value, mappings) {
  if (Array.isArray(value)) return value.map((item) => replaceLegacyRefs(item, mappings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceLegacyRefs(item, mappings)]));
  }
  if (typeof value !== "string") return value;
  let text = value;
  const entries = [...mappings.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [oldId, newId] of entries) {
    text = text.split(oldId).join(newId);
  }
  return text;
}

function dedupeOrdersById(orders = []) {
  const byId = new Map();
  const orderIds = [];
  for (const order of orders || []) {
    const id = String(order?.id || "").trim();
    if (!id) {
      orderIds.push(Symbol("order"));
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, order);
      orderIds.push(id);
      continue;
    }
    byId.set(id, {
      ...byId.get(id),
      ...order,
      childOrders: order.childOrders || byId.get(id).childOrders,
      childOrderDetails: order.childOrderDetails || byId.get(id).childOrderDetails,
      transitCo: order.transitCo || byId.get(id).transitCo
    });
  }
  const seen = new Set();
  return orderIds
    .map((id, index) => typeof id === "symbol" ? orders[index] : byId.get(id))
    .filter((order) => {
      const id = String(order?.id || "").trim();
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function removeDuplicateCoOrders(orders = []) {
  const activeCoIds = new Set(
    (orders || [])
      .map((order) => String(order?.transitCo?.id || ""))
      .filter(Boolean)
  );
  const bestCoBySourceKey = new Map();
  for (const order of orders || []) {
    if (order?.type !== "CO") continue;
    const childOrders = Array.isArray(order.childOrders) ? order.childOrders : [];
    if (!childOrders.length) continue;
    const sourceKey = groupIdFromOrderRefs(childOrders);
    if (!sourceKey) continue;
    const current = bestCoBySourceKey.get(sourceKey);
    const isCanonical = String(order.id || "") === `CO-${sourceKey}`;
    const isActive = activeCoIds.has(String(order.id || ""));
    const score = (isCanonical ? 10 : 0) + (isActive ? 5 : 0);
    const currentScore = current ? (String(current.id || "") === `CO-${sourceKey}` ? 10 : 0) + (activeCoIds.has(String(current.id || "")) ? 5 : 0) : -1;
    if (!current || score > currentScore) bestCoBySourceKey.set(sourceKey, order);
  }
  if (!bestCoBySourceKey.size) return orders;
  return (orders || []).filter((order) => {
    if (order?.type !== "CO") return true;
    const childOrders = Array.isArray(order.childOrders) ? order.childOrders : [];
    if (!childOrders.length) return true;
    const sourceKey = groupIdFromOrderRefs(childOrders);
    const keep = bestCoBySourceKey.get(sourceKey);
    return !keep || String(order.id || "") === String(keep.id || "");
  });
}

async function migrateDispatchSnapshots() {
  const rows = await query(
    `SELECT plan_id, orders, trucks, summary
       FROM dispatch_plan_snapshots
      WHERE orders::text ~* '"id"\\s*:\\s*"(GRP|G[A-Z]+)-'`
  );
  let updated = 0;
  const mappingsByPlan = {};
  for (const row of rows.rows) {
    const mappings = collectGroupMappingsFromOrders(row.orders || []);
    if (!mappings.size) continue;
    const orders = removeDuplicateCoOrders(dedupeOrdersById(replaceLegacyRefs(row.orders || [], mappings)));
    const trucks = replaceLegacyRefs(row.trucks || [], mappings);
    const summary = replaceLegacyRefs(row.summary || {}, mappings);
    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb,
              trucks = $3::jsonb,
              summary = $4::jsonb,
              saved_at = now()
        WHERE plan_id = $1`,
      [row.plan_id, JSON.stringify(orders), JSON.stringify(trucks), JSON.stringify(summary)]
    );
    updated += 1;
    mappingsByPlan[row.plan_id] = Object.fromEntries(mappings.entries());
  }
  return { updated, mappingsByPlan };
}

async function migrateCoRows() {
  const rows = await query(
    `SELECT id, co_ref, source_order_ref, details
       FROM local_co_orders
      WHERE co_ref ILIKE 'CO-GRP-%'
         OR source_order_ref ILIKE 'GRP-%'
         OR source_order_ref ~* '^G[A-Z]+-'
         OR details::text ILIKE '%GRP-%'`
  );
  let updated = 0;
  const mappings = new Map();
  for (const row of rows.rows) {
    const rowMappings = collectGroupMappingsFromCoRows([row]);
    if (!rowMappings.size) continue;
    const coRef = replaceLegacyRefs(row.co_ref, rowMappings);
    const sourceOrderRef = replaceLegacyRefs(row.source_order_ref, rowMappings);
    const details = replaceLegacyRefs(row.details || {}, rowMappings);
    await query(
      `UPDATE local_co_orders
          SET co_ref = $2,
              source_order_ref = $3,
              details = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [row.id, coRef, sourceOrderRef, JSON.stringify(details)]
    );
    updated += 1;
    for (const entry of rowMappings.entries()) mappings.set(entry[0], entry[1]);
  }
  return { updated, mappings: Object.fromEntries(mappings.entries()) };
}

async function migrateOperatorSavedOrders(mappings) {
  const rows = await query(
    `SELECT id, order_key, order_ref
       FROM operator_saved_delivery_orders
      WHERE order_key ILIKE 'GRP-%'
         OR order_key ILIKE 'CO-GRP-%'
         OR order_ref ILIKE 'GRP-%'
         OR order_ref ILIKE 'CO-GRP-%'`
  );
  let updated = 0;
  for (const row of rows.rows) {
    await query(
      `UPDATE operator_saved_delivery_orders
          SET order_key = $2,
              order_ref = $3
        WHERE id = $1`,
      [row.id, replaceLegacyRefs(row.order_key, mappings), replaceLegacyRefs(row.order_ref, mappings)]
    );
    updated += 1;
  }
  return updated;
}

async function main() {
  const result = await withTransaction(async () => ({
    dispatchSnapshots: await migrateDispatchSnapshots(),
    coOrders: await migrateCoRows()
  }));
  const combinedMappings = new Map([
    ...Object.values(result.dispatchSnapshots.mappingsByPlan || {}).flatMap((item) => Object.entries(item)),
    ...Object.entries(result.coOrders.mappings || {})
  ]);
  const savedOrders = combinedMappings.size ? await migrateOperatorSavedOrders(combinedMappings) : 0;
  console.log(JSON.stringify({
    migrated: result.dispatchSnapshots.updated > 0 || result.coOrders.updated > 0 || savedOrders > 0,
    dispatchSnapshots: result.dispatchSnapshots.updated,
    coOrders: result.coOrders.updated,
    savedOrders,
    mappingsByPlan: result.dispatchSnapshots.mappingsByPlan,
    coMappings: result.coOrders.mappings
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
