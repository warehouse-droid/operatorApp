import { query, withTransaction } from "./db.js";
import { scmManualSplitHasOperationalStatusAuthority } from "./scm-manual-split-authority.js";
import { effectiveScmPurchaseOrderCatalogStatus } from "./scm-purchase-order-catalog-status.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const MAX_SEARCH_LENGTH = 120;
const SCM_RESTRICTED_STATUSES = new Set([
  "hold",
  "complete",
  "completed",
  "cancelled",
  "canceled"
]);

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function trueValue(value) {
  return value === true || ["1", "true", "yes"].includes(text(value).toLowerCase());
}

function orderRef(order = {}) {
  return text(order.id || order.orderRef || order.tranid || order.refNumber);
}

function orderKind(order = {}) {
  return order.isScmSplit === true || text(order.parseSource).toLowerCase() === "scm-split"
    ? "split"
    : "po";
}

function iso(value) {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function activityAt(order = {}) {
  return iso(
    order.scmSplitUpdatedAt
    || order.scm?.updatedAt
    || order.updatedAt
    || order.updated_at
    || order.syncedAt
    || order.raw?.synced_at
    || order.scmSplitCreatedAt
  ) || new Date(0).toISOString();
}

function linkedRefs(order = {}) {
  return [...new Set([
    orderRef(order),
    ...(Array.isArray(order.linkedRefs) ? order.linkedRefs : []),
    order.originalPoRef,
    order.dispatchRef,
    order.sourcePoRef,
    ...(order.correspondingPoRefs || []),
    ...(order.scmSearchRefs || []),
    ...(order.childOrders || []),
    order.scm?.groupRef
  ].map(text).filter(Boolean))];
}

function aggregateQuantities(items = []) {
  const totals = { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0 };
  for (const item of items || []) {
    totals.pallets += number(item.pallets ?? item.palletQty);
    totals.layers += number(item.layers ?? item.layerQty);
    totals.sections += number(item.sections ?? item.sectionQty);
    totals.pieces += number(item.pieces ?? item.pieceQty);
    totals.salesQty += number(item.quantity ?? item.salesQty);
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number(value.toFixed(6))]));
}

export function compactScmPurchaseOrderCard(order = {}) {
  const ref = orderRef(order);
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    id: ref,
    type: "PO",
    isBlanket: order.isBlanket === true || order.is_blanket === true
      || order.isBlanketPo === true || order.is_blanket_po === true
      || order.raw?.is_blanket_po === true,
    customer: text(order.customer),
    vendorYard: text(order.vendorYard),
    sourceYard: text(order.sourceYard),
    destinationYard: text(order.destinationYard),
    destinationLocationId: text(order.destinationLocationId),
    originalPoRef: text(order.originalPoRef),
    dispatchRef: text(order.dispatchRef),
    sourcePoRef: text(order.sourcePoRef),
    correspondingPoRefs: [...new Set((order.correspondingPoRefs || []).map(text).filter(Boolean))],
    linkedRefs: linkedRefs(order),
    dropoffs: (Array.isArray(order.dropoffs) ? order.dropoffs : []).slice(0, 20).map((drop) => ({
      destinationYard: text(drop?.destinationYard),
      weight: number(drop?.weight)
    })),
    vendorYardOptions: (Array.isArray(order.vendorYardOptions) ? order.vendorYardOptions : []).slice(0, 20).map((option) => ({
      id: option?.id ?? null,
      vendor: text(option?.vendor),
      yard: text(option?.yard)
    })),
    weight: number(order.weight),
    itemCount: items.length,
    ...aggregateQuantities(items),
    isScmSplit: orderKind(order) === "split",
    scmSplitId: order.scmSplitId ?? null,
    scmSplitRevision: Number(order.scmSplitRevision || 0),
    scmSplitUpdatedAt: order.scmSplitUpdatedAt || null,
    scmSplitLocked: order.scmSplitLocked === true,
    dispatchCompleted: order.dispatchCompleted === true,
    dispatchCompletionEvidenceType: text(order.dispatchCompletionEvidenceType),
    reconciliationStatus: text(order.reconciliationStatus),
    reconciliationReason: text(order.reconciliationReason),
    reconciliationBlocked: order.reconciliationBlocked === true,
    scm: {
      status: text(order.scm?.status),
      method: text(order.scm?.method),
      pickupPoint: text(order.scm?.pickupPoint),
      dropoffPoint: text(order.scm?.dropoffPoint),
      groupRef: text(order.scm?.groupRef),
      etaDate: text(order.scm?.etaDate),
      etaTime: text(order.scm?.etaTime),
      driver: text(order.scm?.driver),
      notes: text(order.scm?.notes),
      remarkOverride: text(order.scm?.remarkOverride),
      updatedAt: order.scm?.updatedAt || null
    },
    updatedAt: activityAt(order)
  };
}

function searchText(order = {}, refs = linkedRefs(order)) {
  return [...new Set([
    ...refs,
    order.customer,
    order.vendorYard,
    order.sourceYard,
    order.destinationYard,
    order.scm?.pickupPoint,
    order.scm?.dropoffPoint,
    ...(order.dropoffs || []).map((drop) => drop?.destinationYard),
    ...(order.vendorYardOptions || []).flatMap((option) => [option?.vendor, option?.yard]),
    ...(order.items || []).flatMap((item) => [item?.sku, item?.itemName, item?.description])
  ].map(text).filter(Boolean))].join(" ").toLowerCase().slice(0, 100_000);
}

function catalogRows(orders = [], source = "") {
  const seen = new Set();
  const rows = [];
  for (const order of orders || []) {
    const ref = orderRef(order);
    const key = ref.toLowerCase();
    if (!ref || seen.has(key)) continue;
    seen.add(key);
    const refs = linkedRefs(order);
    const card = compactScmPurchaseOrderCard(order);
    const vendor = text(card.vendorYardOptions.map((option) => option.vendor).find(Boolean)
      || card.customer || card.vendorYard || card.sourceYard).toLowerCase();
    const pickup = text(card.scm?.pickupPoint || card.vendorYardOptions[0]?.yard || card.sourceYard).toLowerCase();
    rows.push({
      order_ref: ref,
      order_kind: orderKind(order),
      eligible: order.eligible !== false,
      source_updated_at: activityAt(order),
      activity_at: activityAt(order),
      search_text: searchText(order, refs),
      dropoff_key: text(card.destinationYard || card.scm?.dropoffPoint).toLowerCase(),
      vendor_key: vendor,
      pickup_key: pickup,
      linked_refs: refs,
      summary: card,
      detail: { ...order, catalogHydrated: true },
      source: text(source)
    });
  }
  return rows;
}

async function upsertRows(rows = []) {
  if (!rows.length) return { upserted: 0, orderRefs: [] };
  const result = await query(
    `INSERT INTO scm_purchase_order_catalog_entries (
       order_ref, order_kind, eligible, source_updated_at, activity_at,
       search_text, dropoff_key, vendor_key, pickup_key, linked_refs,
       summary, detail, source
     )
     SELECT source.order_ref, source.order_kind, source.eligible,
            source.source_updated_at, source.activity_at, source.search_text,
            source.dropoff_key, source.vendor_key, source.pickup_key,
            source.linked_refs, source.summary, source.detail, source.source
       FROM jsonb_to_recordset($1::jsonb) AS source(
         order_ref text, order_kind text, eligible boolean,
         source_updated_at timestamptz, activity_at timestamptz, search_text text,
         dropoff_key text, vendor_key text, pickup_key text, linked_refs jsonb,
         summary jsonb, detail jsonb, source text
       )
     ON CONFLICT (lower(order_ref)) DO UPDATE
       SET order_ref = EXCLUDED.order_ref,
           order_kind = EXCLUDED.order_kind,
           eligible = EXCLUDED.eligible,
           source_updated_at = EXCLUDED.source_updated_at,
           activity_at = EXCLUDED.activity_at,
           search_text = EXCLUDED.search_text,
           dropoff_key = EXCLUDED.dropoff_key,
           vendor_key = EXCLUDED.vendor_key,
           pickup_key = EXCLUDED.pickup_key,
           linked_refs = EXCLUDED.linked_refs,
           summary = EXCLUDED.summary,
           detail = EXCLUDED.detail,
           source = EXCLUDED.source,
           catalog_revision = scm_purchase_order_catalog_entries.catalog_revision + 1,
           updated_at = now()
     RETURNING order_ref`,
    [JSON.stringify(rows)]
  );
  return { upserted: result.rowCount, orderRefs: result.rows.map((row) => row.order_ref) };
}

export async function upsertScmPurchaseOrderCatalog({ orders = [], source = "" } = {}) {
  return withTransaction(async () => {
    const result = await upsertRows(catalogRows(orders, source));
    await query(
      `UPDATE scm_purchase_order_catalog_state
          SET generation = generation + 1,
              catalog_count = (SELECT count(*)::int FROM scm_purchase_order_catalog_entries),
              updated_at = now()
        WHERE singleton = true`
    );
    return result;
  });
}

export async function replaceScmPurchaseOrderCatalog({ orders = [], source = "" } = {}) {
  const rows = catalogRows(orders, source);
  return withTransaction(async () => {
    const upserted = await upsertRows(rows);
    const refs = rows.map((row) => row.order_ref.toLowerCase());
    const deleted = await query(
      `DELETE FROM scm_purchase_order_catalog_entries
        WHERE NOT (lower(order_ref) = ANY($1::text[]))
        RETURNING order_ref`,
      [refs]
    );
    await query(
      `UPDATE scm_purchase_order_catalog_state
          SET status = 'ready',
              generation = generation + 1,
              catalog_count = $2,
              source = $1,
              last_full_refresh_at = now(),
              last_error = '',
              updated_at = now()
        WHERE singleton = true`,
      [text(source), rows.length]
    );
    return { ...upserted, deleted: deleted.rowCount };
  });
}

export async function removeScmPurchaseOrderCatalogOrder(ref) {
  const cleanRef = text(ref);
  if (!cleanRef) return { deleted: false };
  const result = await query(
    `DELETE FROM scm_purchase_order_catalog_entries
      WHERE lower(order_ref) = lower($1)
      RETURNING order_ref`,
    [cleanRef]
  );
  return { deleted: result.rowCount === 1, orderRef: result.rows[0]?.order_ref || cleanRef };
}

function cursorError() {
  return Object.assign(new Error("The SCM purchase-order cursor is invalid."), {
    status: 400,
    code: "SCM_PURCHASE_ORDER_CURSOR_INVALID"
  });
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text(value), "base64url").toString("utf8"));
    if (!parsed || ![0, 1].includes(Number(parsed.e)) || !iso(parsed.a) || !text(parsed.r)) {
      throw cursorError();
    }
    return { e: Number(parsed.e), a: iso(parsed.a), r: text(parsed.r).toLowerCase() };
  } catch (error) {
    if (error?.code === "SCM_PURCHASE_ORDER_CURSOR_INVALID") throw error;
    throw cursorError();
  }
}

function cursorFromCatalogRow(row = {}) {
  if (!row.activity_at || !text(row.order_ref)) return null;
  return {
    e: Number(row.exact_rank || 0),
    a: new Date(row.activity_at).toISOString(),
    r: text(row.order_ref).toLowerCase()
  };
}

function assignmentFields(row = {}) {
  const planned = Boolean(row.plan_id);
  const details = row.assignment && typeof row.assignment === "object" ? row.assignment : {};
  return {
    dispatchPlanned: planned,
    readOnly: planned,
    dispatchPlanId: planned ? text(row.plan_id) : "",
    dispatchPlanDate: planned ? text(row.plan_date).slice(0, 10) : "",
    dispatchEtaTime: text(details.dispatchEtaTime),
    dispatchTruckPlate: text(details.dispatchTruckPlate),
    dispatchLoadName: text(details.dispatchLoadName),
    dispatchParkingSpot: text(details.dispatchParkingSpot),
    dispatchDriverLogin: text(details.dispatchDriverLogin),
    dispatchDriverName: text(details.dispatchDriverName),
    plannedOrderRef: text(row.planned_order_ref)
  };
}

function assignmentScheduleNotes(order = {}) {
  const parking = text(order.dispatchParkingSpot);
  return [
    text(order.dispatchTruckPlate),
    text(order.dispatchLoadName),
    parking ? `Parking ${parking}` : ""
  ].filter(Boolean).join(" ");
}

function storedScmStatus(order = {}) {
  return text(order.scm?.status) || "Hold";
}

function isRestrictedCatalogOrder(order = {}) {
  if (trueValue(order.isBlanket ?? order.is_blanket ?? order.raw?.is_blanket_po)) return true;
  return SCM_RESTRICTED_STATUSES.has(storedScmStatus(order).toLowerCase());
}

async function currentScmPurchaseOrderStatusEvidence(orderRefs = []) {
  const refs = [...new Set((orderRefs || []).map((ref) => text(ref).toLowerCase()).filter(Boolean))];
  if (!refs.length) return new Map();
  const result = await query(
    `WITH requested(order_key) AS (
       SELECT DISTINCT lower(btrim(value))
         FROM unnest($1::text[]) input(value)
        WHERE btrim(value) <> ''
     )
     SELECT requested.order_key,
            purchase.initial_scm_status AS source_initial_status,
            schedule.id AS schedule_id,
            schedule.status AS schedule_status,
            schedule.updated_at AS schedule_updated_at,
            to_char(
              schedule.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS schedule_concurrency_updated_at,
            schedule.method AS schedule_method,
            schedule.pickup_point AS schedule_pickup_point,
            schedule.dropoff_point AS schedule_dropoff_point,
            schedule.is_special_order AS schedule_is_special_order,
            schedule.packing_slip_ref AS schedule_packing_slip_ref,
            schedule.group_ref AS schedule_group_ref,
            to_char(schedule.eta_date, 'YYYY-MM-DD') AS schedule_eta_date,
            schedule.eta_time AS schedule_eta_time,
            schedule.driver AS schedule_driver,
            schedule.notes AS schedule_notes,
            schedule.dispatch_assignment_note AS schedule_dispatch_assignment_note,
            schedule.remark_override AS schedule_remark_override,
            COALESCE(schedule.reconciliation_blocked, false) AS reconciliation_blocked,
            reconciliation.id AS reconciliation_state_id,
            reconciliation.reconciliation_status,
            reconciliation.reconciled_at,
            COALESCE(
              NULLIF(
                CASE
                  WHEN reconciliation.target_application_status = 'Reconcile Review'
                    THEN reconciliation.application_status
                  ELSE reconciliation.target_application_status
                END,
                ''
              ),
              reconciliation.application_status,
              ''
            ) AS reconciliation_application_status,
            completion.completion_event_id,
            completion.completion_evidence_type
       FROM requested
       LEFT JOIN LATERAL (
         SELECT candidate.initial_scm_status
           FROM purchase_orders candidate
          WHERE upper(btrim(candidate.tranid)) = upper(requested.order_key)
             OR upper(btrim(COALESCE(candidate.dispatch_ref, ''))) = upper(requested.order_key)
          ORDER BY candidate.netsuite_active DESC,
                   CASE
                     WHEN upper(btrim(candidate.tranid)) = upper(requested.order_key) THEN 0
                     ELSE 1
                   END,
                   candidate.synced_at DESC,
                   candidate.netsuite_id DESC
          LIMIT 1
       ) purchase ON true
       LEFT JOIN scm_transport_schedule schedule
         ON schedule.order_kind = 'PO'
        AND lower(btrim(schedule.order_ref)) = requested.order_key
       LEFT JOIN LATERAL (
         SELECT candidate.id,
                candidate.application_status,
                candidate.reconciliation_status,
                candidate.reconciled_at,
                target.application_status AS target_application_status
           FROM scm_reconciliation_order_state candidate
           LEFT JOIN LATERAL (
             SELECT entry.value->>'applicationStatus' AS application_status,
                    true AS matched
               FROM jsonb_each(
                 CASE
                   WHEN jsonb_typeof(candidate.quantity_summary->'targets') = 'object'
                     THEN candidate.quantity_summary->'targets'
                   ELSE '{}'::jsonb
                 END
               ) entry
              WHERE lower(btrim(entry.key)) = requested.order_key
              LIMIT 1
           ) target ON true
          WHERE candidate.order_kind = 'PO'
            AND (
              candidate.id = schedule.reconciliation_order_state_id
              OR lower(btrim(candidate.source_order_ref)) = requested.order_key
              OR target.matched = true
            )
          ORDER BY
            CASE WHEN candidate.id = schedule.reconciliation_order_state_id THEN 1 ELSE 0 END DESC,
            CASE WHEN target.matched = true THEN 1 ELSE 0 END DESC,
            candidate.reconciled_at DESC NULLS LAST,
            candidate.id DESC
          LIMIT 1
       ) reconciliation ON true
       LEFT JOIN dispatch_order_completion_status completion
         ON completion.order_kind = 'PO'
        AND completion.dispatch_completion_status = 'completed'
        AND lower(btrim(completion.order_ref)) = requested.order_key`,
    [refs]
  );
  return new Map(result.rows.map((row) => [row.order_key, row]));
}

async function applyCurrentScmPurchaseOrderStatuses(orders = []) {
  const refsByOrder = orders.map((order) => linkedRefs(order));
  const evidenceByRef = await currentScmPurchaseOrderStatusEvidence(
    refsByOrder.flat()
  );
  return orders.map((order, index) => {
    const exactScheduleEvidence = evidenceByRef.get(text(orderRef(order)).toLowerCase()) || {};
    const candidates = refsByOrder[index]
      .map((ref) => evidenceByRef.get(text(ref).toLowerCase()))
      .filter(Boolean);
    const initialEvidenceWithState = candidates.find((candidate) => (
      candidate.schedule_id
      || candidate.reconciliation_state_id
      || candidate.completion_event_id
    ));
    const initialEvidence = initialEvidenceWithState || candidates[0] || {};
    const initialStatus = effectiveScmPurchaseOrderCatalogStatus(order, initialEvidence);
    const exactManualSplitStatus = order.isScmSplit === true
      && Boolean(exactScheduleEvidence.schedule_id)
      && scmManualSplitHasOperationalStatusAuthority(exactScheduleEvidence.schedule_status, {
        hasActivePlan: order.dispatchPlanned === true,
        derivedStatus: exactScheduleEvidence.reconciliation_application_status
      });
    const linkedCurrentEvidence = !exactManualSplitStatus && initialStatus.toLowerCase() === "queued"
      ? candidates.find((candidate) => (
        !["queued", "planned"].includes(
          effectiveScmPurchaseOrderCatalogStatus(order, candidate).toLowerCase()
        )
      ))
      : null;
    const completion = candidates.find((candidate) => candidate.completion_event_id);
    const evidence = {
      ...(exactManualSplitStatus ? exactScheduleEvidence : linkedCurrentEvidence || initialEvidence),
      ...(completion ? {
        completion_event_id: completion.completion_event_id,
        completion_evidence_type: completion.completion_evidence_type
      } : {})
    };
    const status = effectiveScmPurchaseOrderCatalogStatus(order, evidence);
    const hasExactSchedule = Boolean(exactScheduleEvidence.schedule_id);
    return {
      ...order,
      dispatchCompleted: Boolean(evidence.completion_event_id) || order.dispatchCompleted === true,
      dispatchCompletionEvidenceType: text(evidence.completion_evidence_type)
        || text(order.dispatchCompletionEvidenceType),
      scm: {
        ...(order.scm || {}),
        ...(hasExactSchedule ? {
          method: text(exactScheduleEvidence.schedule_method) || "MBT",
          pickupPoint: text(exactScheduleEvidence.schedule_pickup_point),
          dropoffPoint: text(exactScheduleEvidence.schedule_dropoff_point),
          isSpecialOrder: exactScheduleEvidence.schedule_is_special_order === true,
          packingSlipRef: text(exactScheduleEvidence.schedule_packing_slip_ref),
          groupRef: text(exactScheduleEvidence.schedule_group_ref),
          etaDate: text(exactScheduleEvidence.schedule_eta_date)
            || text(order.dispatchPlanDate) || text(order.scm?.etaDate),
          etaTime: text(exactScheduleEvidence.schedule_eta_time)
            || text(order.dispatchEtaTime) || text(order.scm?.etaTime),
          driver: text(exactScheduleEvidence.schedule_driver)
            || text(order.dispatchDriverName) || text(order.dispatchDriverLogin)
            || text(order.scm?.driver),
          notes: text(exactScheduleEvidence.schedule_notes)
            || text(exactScheduleEvidence.schedule_dispatch_assignment_note)
            || assignmentScheduleNotes(order) || text(order.scm?.notes),
          remarkOverride: text(exactScheduleEvidence.schedule_remark_override)
        } : {}),
        status,
        scheduleId: hasExactSchedule ? Number(exactScheduleEvidence.schedule_id) : null,
        updatedAt: hasExactSchedule
          ? exactScheduleEvidence.schedule_concurrency_updated_at
          : null
      }
    };
  });
}

export async function listScmPurchaseOrderCatalog({
  search = "",
  poType = "",
  dropoff = "",
  vendor = "",
  pickupPoint = "",
  cursor = "",
  limit = DEFAULT_LIMIT,
  includeRestricted = true
} = {}) {
  const needle = text(search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  const requestedKind = ["po", "split"].includes(text(poType).toLowerCase()) ? text(poType).toLowerCase() : "";
  const decoded = decodeCursor(cursor);
  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const batchLimit = Math.min(MAX_LIMIT + 1, Math.max(safeLimit + 1, 50));
  const visible = [];
  let scanCursor = decoded;
  let exhausted = false;
  while (!exhausted && visible.length <= safeLimit) {
    const result = await query(
      `SELECT catalog.order_ref, catalog.summary, catalog.activity_at,
              CASE WHEN $1 <> '' AND lower(catalog.order_ref) = $1 THEN 1 ELSE 0 END AS exact_rank,
              assignment.plan_id::text AS plan_id,
              assignment.plan_date::text AS plan_date,
              assignment.planned_order_ref,
              assignment.assignment
         FROM scm_purchase_order_catalog_entries catalog
         LEFT JOIN LATERAL (
           SELECT candidate.plan_id, candidate.plan_date, candidate.planned_order_ref,
                  candidate.assignment
             FROM dispatch_plan_order_assignments candidate
             JOIN dispatch_plans plan ON plan.id = candidate.plan_id
            WHERE lower(candidate.order_ref) = lower(catalog.order_ref)
              AND plan.status <> 'cancelled'
            ORDER BY candidate.plan_date DESC, candidate.plan_id DESC
            LIMIT 1
         ) assignment ON true
        WHERE catalog.eligible = true
          AND ($2 = '' OR catalog.order_kind = $2)
          AND ($3 = '' OR catalog.dropoff_key = $3)
          AND ($4 = '' OR catalog.vendor_key = $4)
          AND ($5 = '' OR catalog.pickup_key = $5)
          AND ($1 = '' OR lower(catalog.order_ref) = $1 OR catalog.search_text ILIKE ('%' || $1 || '%'))
          AND (
            $6::int IS NULL
            OR CASE WHEN $1 <> '' AND lower(catalog.order_ref) = $1 THEN 1 ELSE 0 END < $6
            OR (
              CASE WHEN $1 <> '' AND lower(catalog.order_ref) = $1 THEN 1 ELSE 0 END = $6
              AND (catalog.activity_at, lower(catalog.order_ref)) < ($7::timestamptz, $8)
            )
          )
        ORDER BY exact_rank DESC, catalog.activity_at DESC, lower(catalog.order_ref) DESC
        LIMIT $9`,
      [
        needle,
        requestedKind,
        text(dropoff).toLowerCase(),
        text(vendor).toLowerCase(),
        text(pickupPoint).toLowerCase(),
        scanCursor?.e ?? null,
        scanCursor?.a || new Date(0).toISOString(),
        scanCursor?.r || "",
        batchLimit
      ]
    );
    const currentOrders = await applyCurrentScmPurchaseOrderStatuses(
      result.rows.map((row) => ({ ...row.summary, ...assignmentFields(row) }))
    );
    for (let index = 0; index < result.rows.length; index += 1) {
      const order = currentOrders[index];
      if (includeRestricted === true || !isRestrictedCatalogOrder(order)) {
        visible.push({ order, row: result.rows[index] });
      }
    }
    exhausted = result.rows.length < batchLimit;
    const nextScanCursor = cursorFromCatalogRow(result.rows.at(-1));
    if (!nextScanCursor) break;
    scanCursor = nextScanCursor;
  }
  const hasMore = visible.length > safeLimit;
  const page = visible.slice(0, safeLimit);
  const last = page.at(-1)?.row;
  const state = await getScmPurchaseOrderCatalogState();
  return {
    orders: page.map((entry) => entry.order),
    nextCursor: hasMore && last ? encodeCursor(cursorFromCatalogRow(last)) : "",
    ready: state.ready,
    source: "indexed",
    catalogRevision: state.generation
  };
}

export async function getScmPurchaseOrderCatalogOrder(ref, { includeRestricted = true } = {}) {
  const cleanRef = text(ref);
  if (!cleanRef) return null;
  const result = await query(
    `SELECT catalog.detail,
            assignment.plan_id::text AS plan_id,
            assignment.plan_date::text AS plan_date,
            assignment.planned_order_ref,
            assignment.assignment
       FROM scm_purchase_order_catalog_entries catalog
       LEFT JOIN LATERAL (
         SELECT candidate.plan_id, candidate.plan_date, candidate.planned_order_ref,
                candidate.assignment
           FROM dispatch_plan_order_assignments candidate
           JOIN dispatch_plans plan ON plan.id = candidate.plan_id
          WHERE lower(candidate.order_ref) = lower(catalog.order_ref)
            AND plan.status <> 'cancelled'
          ORDER BY candidate.plan_date DESC, candidate.plan_id DESC
          LIMIT 1
       ) assignment ON true
      WHERE lower(catalog.order_ref) = lower($1)
      LIMIT 1`,
    [cleanRef]
  );
  const row = result.rows[0];
  if (!row) return null;
  const [order] = await applyCurrentScmPurchaseOrderStatuses([
    { ...row.detail, ...assignmentFields(row) }
  ]);
  return includeRestricted || !isRestrictedCatalogOrder(order) ? order : null;
}

export async function getScmPurchaseOrderCatalogState() {
  const result = await query(
    `SELECT status, generation, catalog_count, source,
            last_full_refresh_at, last_error, updated_at
       FROM scm_purchase_order_catalog_state
      WHERE singleton = true`
  );
  const row = result.rows[0] || {};
  return {
    status: row.status || "warming",
    ready: row.status === "ready" && Boolean(row.last_full_refresh_at),
    generation: Number(row.generation || 0),
    catalogCount: Number(row.catalog_count || 0),
    source: row.source || "",
    lastFullRefreshAt: row.last_full_refresh_at || null,
    lastError: row.last_error || "",
    updatedAt: row.updated_at || null
  };
}

export async function markScmPurchaseOrderCatalogFailed(error) {
  await query(
    `UPDATE scm_purchase_order_catalog_state
        SET status = 'failed', last_error = $1, updated_at = now()
      WHERE singleton = true`,
    [text(error?.message || error || "SCM purchase-order catalog refresh failed.").slice(0, 8_000)]
  );
}

export async function enqueueScmPurchaseOrderCatalogRefresh({ orderRef: ref = "", source = "" } = {}) {
  const cleanRef = text(ref);
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`scm-po-catalog:${cleanRef.toLowerCase()}`]);
    const existing = await query(
      `SELECT id::text, status
         FROM scm_purchase_order_catalog_refresh_outbox
        WHERE COALESCE(lower(order_ref), '') = $1
          AND status IN ('pending', 'running', 'failed')
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      [cleanRef.toLowerCase()]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status !== "running") {
        await query(
          `UPDATE scm_purchase_order_catalog_refresh_outbox
              SET status = 'pending', source = $2, available_at = now(), updated_at = now()
            WHERE id = $1`,
          [existing.rows[0].id, text(source)]
        );
      }
      return { id: existing.rows[0].id, deduplicated: true };
    }
    const inserted = await query(
      `INSERT INTO scm_purchase_order_catalog_refresh_outbox (order_ref, source)
       VALUES (NULLIF($1, ''), $2)
       RETURNING id::text`,
      [cleanRef, text(source)]
    );
    return { id: inserted.rows[0].id, deduplicated: false };
  });
}

export async function claimScmPurchaseOrderCatalogRefreshes({ limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const result = await query(
    `WITH candidates AS (
       SELECT id
         FROM scm_purchase_order_catalog_refresh_outbox
        WHERE status IN ('pending', 'failed') AND available_at <= now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE scm_purchase_order_catalog_refresh_outbox outbox
        SET status = 'running', updated_at = now()
       FROM candidates
      WHERE outbox.id = candidates.id
     RETURNING outbox.id::text, outbox.order_ref, outbox.source, outbox.attempts`,
    [safeLimit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    orderRef: row.order_ref || "",
    source: row.source || "",
    attempts: Number(row.attempts || 0)
  }));
}

export async function completeScmPurchaseOrderCatalogRefresh(id) {
  await query(
    `UPDATE scm_purchase_order_catalog_refresh_outbox
        SET status = 'complete', completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [id]
  );
}

export async function failScmPurchaseOrderCatalogRefresh(id, error) {
  await query(
    `UPDATE scm_purchase_order_catalog_refresh_outbox
        SET status = 'failed', attempts = attempts + 1,
            available_at = now() + (LEAST(300, power(2, LEAST(attempts, 8)))::text || ' seconds')::interval,
            last_error = $2, updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [id, text(error?.message || error || "SCM purchase-order catalog refresh failed.").slice(0, 8_000)]
  );
}
