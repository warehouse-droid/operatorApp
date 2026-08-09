import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { upsertInventoryBalancesBulk } from "./inventory-repository.js";
import {
  fetchInventoryBalancesForItemsFromNetSuite,
  fetchInventoryBalancesFromNetSuite,
  fetchSmartScmSalesHistoryFromNetSuite,
  resolveNetSuiteYardLocations
} from "./netsuite.js";
import {
  SMART_SCM_YARDS,
  getSmartScmSyncStatus,
  listSmartScmPlanningItemIds,
  syncSmartScmPoliciesFromInventoryItems
} from "./smart-scm-item-repository.js";

let inventorySyncPromise = null;
let salesSyncPromise = null;
const SALES_HISTORY_API_SUSPENDED = true;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function todayIso() {
  return isoDate(new Date());
}

function initialHistoryStart() {
  const now = new Date();
  return `${now.getUTCFullYear() - 2}-01-01`;
}

function shiftIsoDate(value, days) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function normalizeNetSuiteDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new Error(`NetSuite returned an invalid transaction date: ${text || "empty"}.`);
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function numericIds(values = []) {
  return [...new Set(values.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

async function resolvedYards() {
  return resolveNetSuiteYardLocations(SMART_SCM_YARDS.map((yard) => ({
    locationId: yard.locationId,
    code: yard.code
  })));
}

async function updateSyncState(sql, params = []) {
  await query(`UPDATE scm_smart_sync_state SET ${sql}, updated_at = now() WHERE id = 1`, params);
}

function inventoryQuantity(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function insertInventorySnapshotRows(runId, rows = []) {
  const uniqueRows = [...new Map((rows || []).map((row) => [
    `${Number(row.item_id)}:${Number(row.location_id)}`,
    row
  ])).values()].filter((row) => Number.isInteger(Number(row.item_id)) && Number.isInteger(Number(row.location_id)));
  for (let offset = 0; offset < uniqueRows.length; offset += 300) {
    const group = uniqueRows.slice(offset, offset + 300);
    const params = [];
    const values = group.map((row) => {
      const fields = [
        Number(runId),
        Number(row.item_id),
        Number(row.location_id),
        String(row.location || ""),
        inventoryQuantity(row.quantity_on_hand),
        inventoryQuantity(row.quantity_available),
        inventoryQuantity(row.quantity_on_order),
        inventoryQuantity(row.quantity_backordered)
      ];
      return `(${fields.map((field) => {
        params.push(field);
        return `$${params.length}`;
      }).join(", ")})`;
    });
    await query(
      `INSERT INTO scm_smart_inventory_snapshots (
         run_id, item_id, location_id, yard_code, quantity_on_hand, quantity_available,
         quantity_on_order, quantity_backordered
       ) VALUES ${values.join(", ")}`,
      params
    );
  }
  return uniqueRows.length;
}

function canonicalInventoryRows(rows, yards, requestedItemIds = []) {
  const localByNetSuiteId = new Map(yards.map((yard) => [String(yard.netsuiteLocationId), yard]));
  const canonical = [];
  const metadata = new Map();
  const present = new Set();
  for (const row of rows || []) {
    const itemId = Number(row.item_id);
    const yard = localByNetSuiteId.get(String(row.location_id));
    if (!Number.isInteger(itemId) || !yard) continue;
    const resolved = {
      ...row,
      location_id: yard.localLocationId,
      location: yard.localLocationCode
    };
    canonical.push(resolved);
    if (!metadata.has(itemId)) metadata.set(itemId, resolved);
    present.add(`${itemId}:${yard.localLocationId}`);
  }
  const targets = requestedItemIds.length ? numericIds(requestedItemIds) : [...metadata.keys()];
  const missingItems = [];
  for (const itemId of targets) {
    const base = metadata.get(itemId);
    if (!base) {
      missingItems.push(itemId);
      continue;
    }
    for (const yard of yards) {
      const key = `${itemId}:${yard.localLocationId}`;
      if (present.has(key)) continue;
      canonical.push({
        ...base,
        location_id: yard.localLocationId,
        location: yard.localLocationCode,
        quantity_on_hand: 0,
        quantity_available: 0,
        quantity_on_order: 0,
        quantity_backordered: 0
      });
      present.add(key);
    }
  }
  if (missingItems.length) {
    const suffix = missingItems.length > 12 ? ` and ${missingItems.length - 12} more` : "";
    throw new Error(`NetSuite returned no yard inventory record for planned item ID(s) ${missingItems.slice(0, 12).join(", ")}${suffix}. Disable or correct those items before planning.`);
  }
  return canonical;
}

async function performInventorySync({ fullCatalog = false, operatorId = null, triggerSource = "manual" } = {}) {
  const started = await withTransaction(async () => {
    await updateSyncState("inventory_status = 'running', inventory_started_at = now(), inventory_error = NULL");
    return query(
      `INSERT INTO scm_smart_inventory_sync_runs (
         trigger_source, full_catalog, created_by
       ) VALUES ($1, $2, $3)
       RETURNING id`,
      [triggerSource, Boolean(fullCatalog), operatorId]
    );
  });
  const snapshotRunId = Number(started.rows[0].id);
  let result;
  try {
    const yards = await resolvedYards();
    let requestedItemIds = [];
    let rows = [];
    if (fullCatalog) {
      rows = await fetchInventoryBalancesFromNetSuite(yards.map((yard) => yard.netsuiteLocationId));
    } else {
      requestedItemIds = await listSmartScmPlanningItemIds();
      if (!requestedItemIds.length) throw new Error("No Item Master rows are enabled for Smart SCM planning.");
      for (let offset = 0; offset < requestedItemIds.length; offset += 180) {
        rows.push(...await fetchInventoryBalancesForItemsFromNetSuite(
          requestedItemIds.slice(offset, offset + 180),
          yards.map((yard) => yard.netsuiteLocationId)
        ));
      }
    }
    const canonical = canonicalInventoryRows(rows, yards, requestedItemIds);
    const observedAt = new Date().toISOString();
    result = await withTransaction(async () => {
      const saved = await upsertInventoryBalancesBulk(canonical);
      const policies = await syncSmartScmPoliciesFromInventoryItems();
      const snapshotBalances = await insertInventorySnapshotRows(snapshotRunId, canonical);
      const requestedCount = fullCatalog
        ? new Set(canonical.map((row) => Number(row.item_id))).size
        : requestedItemIds.length;
      await query(
        `UPDATE scm_smart_inventory_sync_runs
            SET status = 'completed',
                requested_item_count = $2,
                item_count = $3,
                balance_count = $4,
                observed_at = $5::timestamptz,
                completed_at = now(),
                error = NULL
          WHERE id = $1`,
        [snapshotRunId, requestedCount, saved.items, snapshotBalances, observedAt]
      );
      await updateSyncState(
        "inventory_status = 'ready', inventory_synced_at = now(), inventory_item_count = $1, inventory_balance_count = $2, inventory_error = NULL",
        [saved.items, saved.balances]
      );
      return { ...saved, ...policies, snapshotRunId, snapshotBalances };
    });
  } catch (error) {
    const message = String(error.message || error).slice(0, 2000);
    await withTransaction(async () => {
      await query(
        `UPDATE scm_smart_inventory_sync_runs
            SET status = 'failed', error = $2, completed_at = now()
          WHERE id = $1
            AND status = 'running'`,
        [snapshotRunId, message]
      );
      await updateSyncState("inventory_status = 'failed', inventory_error = $1", [message]);
    }).catch(() => null);
    throw error;
  }
  await writeAudit({
    actorType: operatorId ? "operator" : "system",
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.inventory.sync",
    details: {
      triggerSource,
      fullCatalog,
      items: result.items,
      balances: result.balances,
      snapshotRunId: result.snapshotRunId,
      snapshotBalances: result.snapshotBalances,
      policiesTouched: result.policiesTouched
    }
  });
  return { ...result, fullCatalog, syncedAt: new Date().toISOString() };
}

export async function syncSmartScmInventory(options = {}) {
  if (!inventorySyncPromise) {
    inventorySyncPromise = performInventorySync(options).finally(() => { inventorySyncPromise = null; });
  }
  return inventorySyncPromise;
}

function salesFact(row, yardByNetSuiteId) {
  const yard = yardByNetSuiteId.get(String(row.location_id));
  if (!yard) return null;
  const itemId = Number(row.item_id);
  const transactionId = Number(row.transaction_id);
  const lineId = Number(row.line_id);
  const quantity = Math.abs(Number(row.quantity || 0));
  if (!Number.isInteger(itemId) || !Number.isInteger(transactionId) || !Number.isInteger(lineId) || !(quantity > 0)) return null;
  return {
    source: "netsuite",
    sourceKey: `netsuite:${transactionId}:${lineId}`,
    transactionDate: normalizeNetSuiteDate(row.transaction_date),
    documentRef: row.document_ref || null,
    itemId,
    itemName: row.item_name || null,
    quantity,
    deliveryMethod: row.delivery_method || null,
    locationId: yard.localLocationId,
    yardCode: yard.localLocationCode
  };
}

async function insertSalesFacts(rows = []) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const group = rows.slice(offset, offset + 500);
    const params = [];
    const values = group.map((row) => {
      const fields = [
        row.source, row.sourceKey, row.transactionDate, row.documentRef, row.itemId,
        row.itemName, row.quantity, row.deliveryMethod, row.locationId, row.yardCode
      ];
      return `(${fields.map((field) => {
        params.push(field);
        return `$${params.length}`;
      }).join(", ")})`;
    });
    await query(
      `INSERT INTO scm_smart_sales_facts (
         source, source_key, transaction_date, document_ref, item_id, item_name,
         quantity, delivery_method, location_id, yard_code
       ) VALUES ${values.join(", ")}
       ON CONFLICT (source_key) DO UPDATE SET
         transaction_date = EXCLUDED.transaction_date,
         document_ref = EXCLUDED.document_ref,
         item_id = EXCLUDED.item_id,
         item_name = EXCLUDED.item_name,
         quantity = EXCLUDED.quantity,
         delivery_method = EXCLUDED.delivery_method,
         location_id = EXCLUDED.location_id,
         yard_code = EXCLUDED.yard_code`,
      params
    );
  }
}

function boundedDateWindows(startDate, endDate, maximumDays = 92) {
  const windows = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    const windowStart = new Date(cursor);
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + maximumDays - 1);
    if (windowEnd > end) windowEnd.setTime(end.getTime());
    windows.push({ startDate: isoDate(windowStart), endDate: isoDate(windowEnd) });
    cursor.setTime(windowEnd.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

async function fetchSalesWindow(itemIds, yards, startDate, endDate) {
  const rows = [];
  for (const window of boundedDateWindows(startDate, endDate)) {
    for (let offset = 0; offset < itemIds.length; offset += 120) {
      rows.push(...await fetchSmartScmSalesHistoryFromNetSuite({
        itemIds: itemIds.slice(offset, offset + 120),
        locationIds: yards.map((yard) => yard.netsuiteLocationId),
        startDate: window.startDate,
        endDate: window.endDate
      }));
    }
  }
  const yardByNetSuiteId = new Map(yards.map((yard) => [String(yard.netsuiteLocationId), yard]));
  return rows.map((row) => salesFact(row, yardByNetSuiteId)).filter(Boolean);
}

async function replaceSalesWindow(itemIds, startDate, endDate, facts) {
  if (!itemIds.length) return;
  await query(
    `DELETE FROM scm_smart_sales_facts
      WHERE source = 'netsuite'
        AND item_id = ANY($1::bigint[])
        AND transaction_date BETWEEN $2::date AND $3::date`,
    [itemIds, startDate, endDate]
  );
  await insertSalesFacts(facts);
}

async function performSalesSync({ fullHistory = false, operatorId = null, triggerSource = "manual" } = {}) {
  await updateSyncState("sales_status = 'running', sales_started_at = now(), sales_error = NULL");
  try {
    const itemIds = await listSmartScmPlanningItemIds();
    if (!itemIds.length) throw new Error("No Item Master rows are enabled for Smart SCM forecasting.");
    const [yards, stateResult, existingResult] = await Promise.all([
      resolvedYards(),
      query("SELECT * FROM scm_smart_sync_state WHERE id = 1"),
      query(
        `SELECT item_id
           FROM scm_smart_sales_facts
          WHERE source = 'netsuite' AND item_id = ANY($1::bigint[])
          GROUP BY item_id`,
        [itemIds]
      )
    ]);
    const state = stateResult.rows[0] || {};
    const existing = new Set(existingResult.rows.map((row) => Number(row.item_id)));
    const newItems = fullHistory ? itemIds : itemIds.filter((id) => !existing.has(id));
    const incrementalItems = fullHistory ? [] : itemIds.filter((id) => existing.has(id));
    const coverageStart = fullHistory || !state.sales_coverage_start
      ? initialHistoryStart()
      : String(state.sales_coverage_start).slice(0, 10);
    const endDate = todayIso();
    const batches = [];
    if (newItems.length) {
      batches.push({
        itemIds: newItems,
        startDate: coverageStart,
        endDate,
        facts: await fetchSalesWindow(newItems, yards, coverageStart, endDate)
      });
    }
    if (incrementalItems.length) {
      const through = state.sales_synced_through ? String(state.sales_synced_through).slice(0, 10) : endDate;
      const incrementalStart = [coverageStart, shiftIsoDate(through, -90)].sort().at(-1);
      batches.push({
        itemIds: incrementalItems,
        startDate: incrementalStart,
        endDate,
        facts: await fetchSalesWindow(incrementalItems, yards, incrementalStart, endDate)
      });
    }
    const imported = batches.reduce((sum, batch) => sum + batch.facts.length, 0);
    await withTransaction(async () => {
      for (const batch of batches) {
        await replaceSalesWindow(batch.itemIds, batch.startDate, batch.endDate, batch.facts);
      }
    });
    const countResult = await query("SELECT COUNT(*)::bigint AS count, MIN(transaction_date) AS start_date, MAX(transaction_date) AS end_date FROM scm_smart_sales_facts WHERE source = 'netsuite'");
    const count = Number(countResult.rows[0]?.count || 0);
    const actualStart = countResult.rows[0]?.start_date || coverageStart;
    const actualEnd = countResult.rows[0]?.end_date || endDate;
    await updateSyncState(
      "sales_status = 'ready', sales_synced_at = now(), sales_coverage_start = $1::date, sales_synced_through = $2::date, sales_fact_count = $3, sales_error = NULL",
      [actualStart, endDate, count]
    );
    await writeAudit({
      actorType: operatorId ? "operator" : "system",
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.sales.sync",
      details: { triggerSource, fullHistory, itemCount: itemIds.length, imported, stored: count, coverageStart: actualStart, dataThrough: actualEnd }
    });
    return { itemCount: itemIds.length, imported, stored: count, coverageStart: actualStart, dataThrough: actualEnd, syncedThrough: endDate };
  } catch (error) {
    await updateSyncState("sales_status = 'failed', sales_error = $1", [String(error.message || error).slice(0, 2000)]).catch(() => null);
    throw error;
  }
}

export async function syncSmartScmSalesHistory(options = {}) {
  if (SALES_HISTORY_API_SUSPENDED) {
    throw Object.assign(new Error("NetSuite sales-history API sync is suspended. Upload a raw sales CSV in Smart SCM."), { status: 409 });
  }
  if (!salesSyncPromise) {
    salesSyncPromise = performSalesSync(options).finally(() => { salesSyncPromise = null; });
  }
  return salesSyncPromise;
}

export async function refreshSmartScmLiveData({
  fullCatalog = false,
  fullHistory = false,
  includeSales = false,
  operatorId = null,
  triggerSource = "manual"
} = {}) {
  const inventory = await syncSmartScmInventory({ fullCatalog, operatorId, triggerSource });
  if (includeSales && SALES_HISTORY_API_SUSPENDED) {
    throw Object.assign(new Error("NetSuite sales-history API sync is suspended. Upload a raw sales CSV in Smart SCM."), { status: 409 });
  }
  const sales = includeSales ? await syncSmartScmSalesHistory({ fullHistory, operatorId, triggerSource }) : null;
  return { inventory, sales, status: await getSmartScmSyncStatus() };
}
