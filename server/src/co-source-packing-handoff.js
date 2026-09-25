import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { lockConsolidatedLoadOrders } from "./consolidation-load-locks.js";
import { dispatchLocationsShareYard } from "./dispatch-location.js";
import { assertNoActiveOperatorNetSuitePostingClaims } from "./operator-netsuite-posting-repository.js";

const ACTIVE_CO_STATUSES = ["pending_load", "preparing", "packed", "planned"];
const PACKING_FIELDS = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
const CO_SOURCE_SALES_JOIN = `(co.source_order_ref=sales.tranid OR co.details->'childOrderIds' ? sales.tranid)
  AND (co.from_location_id=sales.outbound_location_id
    OR lower(btrim(split_part(co.from_location,':',1)))=lower(btrim(split_part(sales.outbound_location,':',1))))`;

function handoffError(message, code = "CO_SOURCE_PACKING_EXECUTED") {
  return Object.assign(new Error(message), { code, status: 409 });
}

function hasPacking(line) {
  return Boolean(line.confirmed || line.confirmed_at || PACKING_FIELDS.some(field => Number(line[field] || 0) > 0));
}

function sourceRefs(options, existing) {
  return [...new Set([
    options.sourceOrderRef, ...(options.childRefs || []), existing?.source_order_ref,
    ...(existing?.details?.childOrderIds || [])
  ].map(value => String(value || "").trim()).filter(Boolean))];
}

async function lockSourceOrders(options, existing) {
  const refs = sourceRefs(options, existing);
  const candidates = (await query("SELECT netsuite_id,outbound_location FROM sales_orders WHERE tranid=ANY($1::text[])", [refs])).rows
    .filter(row => dispatchLocationsShareYard(row.outbound_location, options.fromYard));
  const ids = candidates.map(row => row.netsuite_id);
  await lockConsolidatedLoadOrders([...ids, ...(existing?.delivery_order_id ? [existing.delivery_order_id] : [])]);
  const orders = (await query("SELECT * FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id FOR UPDATE", [ids])).rows
    .filter(row => dispatchLocationsShareYard(row.outbound_location, options.fromYard));
  const lockedIds = orders.map(row => row.netsuite_id);
  const lines = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [lockedIds])).rows;
  return { orders, lines };
}

function sourceHasExecution(order, lines) {
  return ["loaded", "partial_loaded", "fulfilled"].includes(String(order.operator_status || "").toLowerCase())
    || String(order.local_yard_order_status || "").toLowerCase() === "loaded"
    || ["fulfilled", "partial_fulfilled"].includes(order.fulfillment_status)
    || Boolean(order.fulfilled_at)
    || lines.some(line => ["loaded_qty", "fulfilled_pallet_qty", "fulfilled_layer_qty", "fulfilled_section_qty", "fulfilled_piece_qty"]
      .some(field => Number(line[field] || 0) > 0));
}

async function assertUnexecutedSources(orders, lines, coRef) {
  for (const order of orders) {
    if (sourceHasExecution(order, lines.filter(line => String(line.sales_order_id) === String(order.netsuite_id)))) {
      throw handoffError(`${order.tranid} has loading or fulfillment evidence; its packing cannot be released to ${coRef}.`);
    }
  }
  await assertNoActiveOperatorNetSuitePostingClaims({ functionKey: "delivery_prep",
    localOrderKeys: orders.map(order => `delivery_prep:sales_order:${order.netsuite_id}`) });
  const activity = await query(`SELECT job_id FROM driver_job_records
    WHERE order_refs ?| $1::text[] AND status IN ('in_progress','complete','completed') LIMIT 1`,
  [[coRef, ...orders.map(order => order.tranid)]]);
  if (activity.rowCount) {throw handoffError(`Driver work has started for ${coRef} or its source SO; packing cannot be released.`);}
}

async function releaseSourcePacking(orders, lines, coRef, requestedBy) {
  for (const order of orders) {
    const packed = lines.filter(line => String(line.sales_order_id) === String(order.netsuite_id) && hasPacking(line));
    const headerHasPacking = ["packed", "confirmed", "preparing"].includes(order.operator_status)
      || order.preparing_operator_id || order.preparing_started_at;
    if (!packed.length && !headerHasPacking) {continue;}
    await query(`UPDATE sales_order_lines SET packed_pallet_qty=0,packed_layer_qty=0,
      packed_section_qty=0,packed_piece_qty=0,packed_sales_qty=0,confirmed=false,confirmed_at=null
      WHERE id=ANY($1::bigint[])`, [packed.map(line => line.id)]);
    await query(`UPDATE sales_orders SET operator_status='open',preparing_operator_id=null,
      preparing_started_at=null,status_updated_at=now() WHERE netsuite_id=$1`, [order.netsuite_id]);
    await writeAudit({ actorType: "dispatcher", source: "dispatch", action: "delivery.co.source_packing.released",
      orderId: order.netsuite_id, details: { coRef, sourceOrderRef: order.tranid, requestedBy,
        previousOperatorStatus: order.operator_status, previousPreparingOperatorId: order.preparing_operator_id,
        previousPreparingStartedAt: order.preparing_started_at,
        lines: packed.map(line => Object.fromEntries(["id", "line_id", "item_id", ...PACKING_FIELDS, "confirmed", "confirmed_at"]
          .map(field => [field, line[field]]))) } });
  }
}

function acceptsPackingHandoff(co, options) {
  return !co.loaded_at && !co.received_at && (ACTIVE_CO_STATUSES.includes(co.status)
    || (co.status === "cancelled" && options.reactivateCancelled === true));
}

export function withCoSourcePackingHandoff(options, saveCo) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`co-source-packing:${options.coRef}`]);
    const existing = (await query("SELECT * FROM local_co_orders WHERE co_ref=$1", [options.coRef])).rows[0];
    if (existing && !acceptsPackingHandoff(existing, options)) {
      return saveCo();
    }
    const { orders, lines } = await lockSourceOrders(options, existing);
    if (existing) {
      const current = (await query("SELECT * FROM local_co_orders WHERE id=$1 FOR UPDATE", [existing.id])).rows[0];
      if (!acceptsPackingHandoff(current, options)) {return saveCo();}
    }
    if (orders.length) {await assertUnexecutedSources(orders, lines, options.coRef);}
    const co = await saveCo();
    await releaseSourcePacking(orders, lines, co.co_ref, options.requestedBy || "");
    return co;
  });
}

export async function releaseExistingCoSourcePacking(coRef, { requestedBy = "" } = {}) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`co-source-packing:${coRef}`]);
    const co = (await query("SELECT * FROM local_co_orders WHERE co_ref=$1", [String(coRef)])).rows[0];
    if (!co) {throw new Error("Local CO order not found.");}
    return withCoSourcePackingHandoff({ coRef: co.co_ref, sourceOrderRef: co.source_order_ref,
      fromYard: co.from_location, childRefs: co.details?.childOrderIds || [], requestedBy }, async () => co);
  });
}

export async function assertNoCoSourcePacking(order) {
  const sources = [...(order?.is_dispatch_group ? order.child_orders || [] : [order])]
    .filter(row => row?.order_type === "sales_order");
  if (!sources.length) {return;}
  const result = await query(`SELECT co.co_ref FROM local_co_orders co
    JOIN sales_orders source ON (co.source_order_ref=source.tranid OR co.details->'childOrderIds' ? source.tranid)
    WHERE source.netsuite_id=ANY($1::bigint[]) AND co.status=ANY($2::text[])
      AND co.loaded_at IS NULL AND co.received_at IS NULL
      AND (co.from_location_id=source.outbound_location_id
        OR lower(btrim(split_part(co.from_location,':',1)))=lower(btrim(split_part(source.outbound_location,':',1))))
    ORDER BY co.id LIMIT 1`, [sources.map(row => row.netsuite_id), ACTIVE_CO_STATUSES]);
  if (result.rowCount) {
    throw handoffError(`Packing has moved to ${result.rows[0].co_ref}. Open that CO to pack or load this cargo.`, "CO_SOURCE_PACKING_HANDOFF");
  }
}

export async function coSourcePackingOrders(salesRefs) {
  return (await query(`SELECT DISTINCT co.id,co.delivery_order_id
    FROM local_co_orders co JOIN sales_orders sales ON ${CO_SOURCE_SALES_JOIN}
    WHERE sales.tranid=ANY($1::text[]) AND co.status<>'cancelled'`, [salesRefs])).rows;
}

export function completedCoArrivalSql(alias = "co") {
  return `COALESCE(${alias}.received_at, (
    SELECT completion.completed_at FROM driver_job_records completion
    WHERE completion.job_id=${alias}.details->>'driverCompletionJobId'
      AND completion.id::text=${alias}.details->>'driverCompletionRecordId'
      AND completion.stop_type='dropoff' AND completion.status IN ('complete','completed')
      AND completion.order_refs @> jsonb_build_array(${alias}.co_ref)
      AND completion.completed_at >= ${alias}.created_at
      AND lower(btrim(completion.job_details->>'location'))=lower(btrim(${alias}.to_location))
  ))`;
}

export async function coSourcePackingActivityRefs(salesRefs, salesLineIds = null, { allowReceivedCo = false } = {}) {
  const result = await query(`SELECT DISTINCT sales.tranid AS ref
    FROM local_co_orders co JOIN sales_orders sales ON ${CO_SOURCE_SALES_JOIN}
    JOIN sales_order_lines line ON line.sales_order_id=sales.netsuite_id
      AND ($2::bigint[] IS NULL OR line.id=ANY($2::bigint[]))
    LEFT JOIN local_co_order_lines co_line ON co_line.co_id=co.id AND (
      co_line.raw->>'lineRowId'=line.id::text OR co_line.raw->>'line_row_id'=line.id::text
      OR (COALESCE(NULLIF(co_line.raw->>'lineRowId',''),NULLIF(co_line.raw->>'line_row_id','')) IS NULL
        AND co_line.line_id=line.line_id AND co_line.item_id=line.item_id))
    WHERE sales.tranid=ANY($1::text[]) AND co.status<>'cancelled'
      AND NOT ($3::boolean AND co.status='completed' AND ${completedCoArrivalSql()} IS NOT NULL) AND (
      co.preparing_operator_id IS NOT NULL OR co.preparing_started_at IS NOT NULL
      OR co.status IN ('preparing','loaded','received','completed') OR co.loaded_at IS NOT NULL OR co.received_at IS NOT NULL
      OR ($2::bigint[] IS NULL AND co.status='packed') OR co_line.confirmed_at IS NOT NULL
      OR COALESCE(co_line.packed_pallet_qty,0)>0 OR COALESCE(co_line.packed_layer_qty,0)>0
      OR COALESCE(co_line.packed_section_qty,0)>0 OR COALESCE(co_line.packed_piece_qty,0)>0
      OR COALESCE(co_line.packed_sales_qty,0)>0)`, [salesRefs, salesLineIds, allowReceivedCo]);
  return result.rows.map(row => row.ref);
}
