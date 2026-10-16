// @ts-check
import crypto from "node:crypto";
import { ensureOutboundLocationDirectory } from "./outbound-location-runtime.js";
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { lockConsolidatedLoadOrders } from "./consolidation-load-locks.js";
import { listClosedNetSuiteOrders } from "./netsuite-closed-order-repository.js";
import { outboundYardLocationId, OUTBOUND_YARD_IDS } from "./outbound-location-domain.js";
import { operatorProgressStatus, readOperatorProgressActor } from "./operator-order-progress-repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PACK_FIELDS = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
/** @type {Record<string, {header: string, id: string, lines: string, parent: string, status: string}>} */
const TARGETS = {
  sales_order: { header: "sales_orders", id: "netsuite_id", lines: "sales_order_lines", parent: "sales_order_id", status: "operator_status" },
  transfer_order: { header: "transfer_orders", id: "netsuite_id", lines: "transfer_order_lines", parent: "transfer_order_id", status: "outbound_operator_status" },
  co_order: { header: "local_co_orders", id: "id", lines: "local_co_order_lines", parent: "co_id", status: "status" },
  vrma_order: { header: "scm_vrma_orders", id: "id", lines: "scm_vrma_order_lines", parent: "vrma_order_id", status: "operator_status" }
};
const CATALOG = `SELECT 'sales_order' AS kind,netsuite_id::text AS id,tranid AS ref,netsuite_id::text AS order_id,
    outbound_location_id AS location_id,outbound_location AS location,operator_status AS status FROM sales_orders
  UNION ALL SELECT 'transfer_order',netsuite_id::text,tranid,netsuite_id::text,from_location_id,from_location,outbound_operator_status FROM transfer_orders
  UNION ALL SELECT 'co_order',id::text,co_ref,COALESCE(delivery_order_id,-id)::text,from_location_id,from_location,status FROM local_co_orders
  UNION ALL SELECT 'vrma_order',id::text,vrma_ref,'VRMA:'||vrma_ref,NULL::bigint,pickup_location,operator_status FROM scm_vrma_orders`;

/** @param {string} message @param {string} code @param {number} [status] */
const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
/** @param {unknown} value */
const text = (/** @type {any} */ value) => String(value ?? "").trim();
/** @param {any} value */
const digest = (/** @type {any} */ value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** @param {any} order */
const orderKey = (/** @type {any} */ order) => `${order.kind}:${order.id}`;

/** @param {any} actor */
function controlYards(actor) {
  const roles = new Set([actor?.role, ...(actor?.roles || [])]);
  if (!actor?.id || (!roles.has("admin") && !roles.has("yard_manager"))) {
    throw fail("A Control account is required to reopen Operator orders.", "OPERATOR_REOPEN_FORBIDDEN", 403);
  }
  if (roles.has("admin")) { return [...OUTBOUND_YARD_IDS]; }
  const allowed = (actor.yardLocationIds || []).map(Number).filter((/** @type {any} */ id) => OUTBOUND_YARD_IDS.includes(id));
  if (!allowed.length) { throw fail("No Control yards are assigned to this account.", "OPERATOR_REOPEN_YARD_FORBIDDEN", 403); }
  return allowed;
}

/** @param {any} identity */
function identityYard(identity) {
  const code = text(identity.location).split(":")[0].trim();
  return outboundYardLocationId(identity.location_id)
    || ({ "3445": 1, "2967": 28, "12441": 15, "150": 26 })[code] || null;
}

/** @param {string} reference */
async function identities(reference) {
  const ref = text(reference).replace(/^VRMA:/iu, "");
  if (!ref || ref.length > 500) { throw fail("Enter an order number.", "OPERATOR_REOPEN_INPUT", 400); }
  const exact = (await query(`SELECT * FROM (${CATALOG}) catalog WHERE upper(ref)=upper($1) OR order_id=$1`, [ref])).rows;
  if (exact.length > 1) { throw fail("This order identity is ambiguous. Use its order number.", "OPERATOR_REOPEN_AMBIGUOUS"); }
  if (exact.length) { return { ref: exact[0].ref, members: exact, declaration: [exact[0].ref] }; }
  const group = (await query(`SELECT full_order->'childOrders' AS members FROM dispatch_global_order_groups
      WHERE upper(group_ref)=upper($1) AND active=true
    UNION ALL SELECT jsonb_agg(m.member_order_ref ORDER BY m.position)
      FROM dispatch_delivery_groups g JOIN dispatch_delivery_group_members m ON m.group_ref=g.group_ref
      WHERE upper(g.group_ref)=upper($1) AND g.active=true GROUP BY g.group_ref`, [ref])).rows[0];
  const members = group?.members || (ref.includes("+") ? ref.split("+").map(text) : []);
  if (!Array.isArray(members) || !members.length || members.length > 50 || new Set(members.map(text)).size !== members.length) {
    throw fail(`${ref} was not found locally.`, "OPERATOR_REOPEN_NOT_FOUND", 404);
  }
  const resolved = [];
  for (const member of members) {
    const rows = (await query(`SELECT * FROM (${CATALOG}) catalog WHERE upper(ref)=upper($1)`, [text(member)])).rows;
    if (rows.length !== 1) { throw fail(`${text(member)} is not a unique local Operator order.`, "OPERATOR_REOPEN_NOT_FOUND", 404); }
    resolved.push(rows[0]);
  }
  return { ref, members: resolved.sort((a, b) => orderKey(a).localeCompare(orderKey(b))), declaration: members };
}

/** @param {any} identity @param {boolean} lock */
async function memberState(identity, lock) {
  const target = TARGETS[identity.kind];
  const header = (await query(`SELECT * FROM ${target.header} WHERE ${target.id}=$1 ${lock ? "FOR UPDATE" : ""}`, [identity.id])).rows[0];
  if (!header) { throw fail(`${identity.ref} changed. Preview it again.`, "OPERATOR_REOPEN_STALE"); }
  const lines = (await query(`SELECT * FROM ${target.lines} WHERE ${target.parent}=$1 ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [identity.id])).rows;
  return { ...identity, header, lines };
}

/** @param {any[]} orders @param {number[]} allowed */
function assertMemberYards(orders, allowed) {
  for (const order of orders) {
    const yards = [identityYard(order)];
    if (order.kind === "sales_order") {
      for (const line of order.lines.filter((/** @type {any} */ row) => row.netsuite_active !== false && ["InvtPart", "NonInvtPart"].includes(row.item_type))) {
        yards.push(outboundYardLocationId(line.location_id ?? order.location_id));
      }
    }
    if (yards.some((/** @type {any} */ yard) => !yard || !allowed.includes(yard))) {
      throw fail(`${order.ref} is outside your assigned Control yards.`, "OPERATOR_REOPEN_YARD_FORBIDDEN", 403);
    }
  }
}

/** @param {any[]} orders */
async function retainedPhotos(orders) {
  const refs = orders.map((/** @type {any} */ order) => order.ref);
  const ids = orders.map((/** @type {any} */ order) => order.order_id).filter((/** @type {any} */ id) => /^-?\d+$/u.test(id || ""));
  const history = (await query(`SELECT photo_data_url,photo_data_urls FROM operator_load_records
    WHERE order_ref=ANY($1::text[]) OR order_id=ANY($2::bigint[]) ORDER BY created_at,id`, [refs, ids])).rows;
  const salesIds = orders.filter((/** @type {any} */ order) => order.kind === "sales_order" || order.kind === "transfer_order").map((/** @type {any} */ order) => order.id);
  const fulfillments = (await query(`SELECT photo_data_url,photo_data_urls FROM delivery_fulfillment_records
    WHERE order_id=ANY($1::bigint[]) ORDER BY created_at,id`, [salesIds])).rows;
  const corrections = (await query("SELECT retained_photo_refs FROM operator_order_reopens WHERE order_keys && $1::text[] ORDER BY created_at,id",
    [orders.map(orderKey)])).rows;
  return [...new Set([...history, ...fulfillments].flatMap((/** @type {any} */ row) => [...(row.photo_data_urls || []), row.photo_data_url])
    .concat(corrections.flatMap((/** @type {any} */ row) => row.retained_photo_refs))
    .filter((/** @type {any} */ ref) => typeof ref === "string" && /^(r2:\/\/|data:image\/|operator-photo:\/\/)/u.test(ref)))];
}

/** @param {any[]} orders @param {string} ref */
async function reopenBlockers(orders, ref) {
  /** @type {{code: string, message: string}[]} */
  const blockers = [];
  const add = (/** @type {string} */ code, /** @type {string} */ message) => blockers.push({ code, message });
  const refs = [...new Set([ref, ...orders.map((/** @type {any} */ order) => order.ref)])];
  const closed = await listClosedNetSuiteOrders(refs);
  for (const row of closed) { add("OPERATOR_REOPEN_CLOSED", `${orders.find((/** @type {any} */ order) => order.ref.toUpperCase() === String(row.canonicalRef || row.requestedRef).toUpperCase())?.ref || row.requestedRef} is closed in NetSuite.`); }
  for (const order of orders) {
    const h = order.header;
    if (h.netsuite_active === false || /^(cancelled|canceled|closed|hold|completed|received)$/iu.test(text(h.status))) {
      add("OPERATOR_REOPEN_INACTIVE", `${order.ref} is inactive, cancelled, completed or on hold.`);
    }
    // Billing alone can be incorrect; retain every recorded fulfillment guard.
    if ((order.kind === "sales_order" && (/^F$/u.test(text(h.status)) || /^(?:Sales Order\s*:\s*)?Pending Billing$/iu.test(text(h.status_text))))
      || h.last_item_fulfillment_id || h.fulfilled_at || /^(fulfilled|partial_fulfilled|shipped)$/iu.test(text(h.fulfillment_status))
      || order.lines.some((/** @type {any} */ line) => ["fulfilled_pallet_qty", "fulfilled_layer_qty", "fulfilled_piece_qty", "fulfilled_section_qty"].some((/** @type {any} */ key) => Number(line[key] || 0) > 0))) {
      add("OPERATOR_REOPEN_NETSUITE_EVIDENCE", `${order.ref} has recorded NetSuite fulfillment. Use the reattempt workflow.`);
    }
    if (h.last_item_receipt_id || h.received_at || /^(received|completed)$/iu.test(text(h.receiving_status))
      || order.lines.some((/** @type {any} */ line) => ["received_pallet_qty", "received_layer_qty", "received_piece_qty", "received_section_qty", "netsuite_received_qty"]
        .some((/** @type {any} */ key) => Number(line[key] || 0) > 0))) {
      add("OPERATOR_REOPEN_RECEIVED", `${order.ref} has receiving evidence and cannot be reset in Operator.`);
    }
  }
  const salesIds = orders.filter((/** @type {any} */ order) => order.kind === "sales_order").map((/** @type {any} */ order) => order.id);
  const reloads = (await query(`SELECT order_ref FROM operator_reload_cycles WHERE sales_order_id=ANY($1::bigint[])
    AND status IN ('authorized','preparing','packed','in_progress')`, [salesIds])).rows;
  for (const row of reloads) { add("OPERATOR_REOPEN_RELOAD_ACTIVE", `${row.order_ref} has an active reload or reattempt. Finish or cancel that cycle first.`); }
  const keys = orders.flatMap((/** @type {any} */ order) => ["delivery_prep", "customer_pickup", "receiving"].map((/** @type {any} */ fn) => `${fn}:${order.kind}:${order.order_id}`));
  const posting = (await query(`SELECT c.id,c.status FROM operator_netsuite_posting_commands c
    JOIN operator_netsuite_posting_order_claims claim ON claim.command_id=c.id
    WHERE claim.local_order_key=ANY($1::text[]) AND (claim.active OR EXISTS (
      SELECT 1 FROM operator_netsuite_posting_steps s WHERE s.command_id=c.id
        AND (s.netsuite_transaction_id IS NOT NULL OR s.status='posted' OR s.response->'observedTransaction'->>'id' IS NOT NULL)))`, [keys])).rows;
  if (posting.length) { add("OPERATOR_REOPEN_POSTING", `${ref} has active or posted NetSuite work. Resolve the posting before reopening.`); }
  const consolidation = await query("SELECT order_id FROM operator_consolidated_load_claims WHERE active AND order_id=ANY($1::text[])",
    [orders.map((/** @type {any} */ order) => order.order_id)]);
  if (consolidation.rowCount) { add("OPERATOR_REOPEN_CONSOLIDATION", `${ref} belongs to a pending Consolidation Load. Resolve that load first.`); }
  const driver = await query(`SELECT job_id FROM driver_job_records WHERE order_refs ?| $1::text[]
    AND (started_at IS NOT NULL OR completed_at IS NOT NULL OR status IN ('in_progress','complete','completed'))`, [refs]);
  if (driver.rowCount) { add("OPERATOR_REOPEN_DRIVER_STARTED", `${ref} has started Driver work. Reopen the Driver stop first.`); }
  const fulfillment = await query("SELECT id FROM delivery_fulfillment_records WHERE order_id=ANY($1::bigint[]) AND item_fulfillment_id IS NOT NULL",
    [orders.filter((/** @type {any} */ order) => ["sales_order", "transfer_order"].includes(order.kind)).map((/** @type {any} */ order) => order.id)]);
  if (fulfillment.rowCount) { add("OPERATOR_REOPEN_NETSUITE_EVIDENCE", `${ref} has recorded NetSuite fulfillment. Use the reattempt workflow.`); }
  return blockers;
}

/** @param {string} orderRef @param {any} actor @param {boolean} [lock] */
async function context(orderRef, actor, lock = false) {
  const allowedYards = controlYards(actor);
  let target = await identities(orderRef);
  if (lock) {
    await lockConsolidatedLoadOrders(target.members.map((/** @type {any} */ order) => order.order_id));
    const freshTarget = await identities(orderRef);
    if (JSON.stringify(freshTarget.members.map(orderKey)) !== JSON.stringify(target.members.map(orderKey))) {
      throw fail("Group membership changed. Preview the order again.", "OPERATOR_REOPEN_STALE");
    }
    target = freshTarget;
  }
  const orders = [];
  for (const identity of target.members) { orders.push(await memberState(identity, lock)); }
  assertMemberYards(orders, allowedYards);
  const photos = await retainedPhotos(orders);
  const blockers = await reopenBlockers(orders, target.ref);
  const lastCorrection = (await query("SELECT id FROM operator_order_reopens WHERE order_keys && $1::text[] ORDER BY created_at DESC,id DESC LIMIT 1",
    [orders.map(orderKey)])).rows[0]?.id || null;
  const stateHash = digest({ ref: target.ref, declaration: target.declaration, orders, photos, blockers, lastCorrection });
  return { target, orders, photos, blockers, stateHash };
}

/** @param {{orderRef: string, actor: any}} input */
export async function previewOperatorOrderReopen({ orderRef, actor }) {
  controlYards(actor);
  await ensureOutboundLocationDirectory();
  return withTransaction(async () => {
    const c = await context(orderRef, actor);
    const orders = [];
    for (const order of c.orders) {
      const status = operatorProgressStatus(order.header, order.lines.filter((/** @type {any} */ line) => line.line_stage !== "receiving"));
      orders.push({ orderRef: order.ref, orderType: order.kind, status: order.header[TARGETS[order.kind].status], progress: status,
        operator: await readOperatorProgressActor({ orderId: /^-?\d+$/u.test(order.order_id || "") ? order.order_id : null,
          orderRef: order.ref, status, preparingOperatorId: order.header.preparing_operator_id, correctionKey: orderKey(order) }),
        lineCount: order.lines.filter((/** @type {any} */ line) => line.line_stage !== "receiving").length });
    }
    return { orderRef: c.target.ref, stateHash: c.stateHash, orders, allowed: !c.blockers.length,
      blockers: c.blockers, retainedPhotoCount: c.photos.length };
  });
}

/** @param {{search: string, actor: any}} input */
export async function searchOperatorReopenOrders({ search, actor }) {
  const allowed = controlYards(actor);
  const term = text(search);
  if (term.length < 2 || term.length > 500) { throw fail("Enter at least two characters of an order number.", "OPERATOR_REOPEN_INPUT", 400); }
  if (term.includes("+")) {
    const preview = await previewOperatorOrderReopen({ orderRef: term, actor });
    return [{ orderRef: preview.orderRef, orderType: "group_order", status: "group" }];
  }
  await ensureOutboundLocationDirectory();
  const pattern = term.replace(/[\\%_]/gu, (/** @type {any} */ value) => "\\" + value);
  return (await query(`SELECT * FROM (${CATALOG}) catalog WHERE ref ILIKE '%'||$1||'%' ORDER BY ref LIMIT 100`, [pattern])).rows
    .filter((/** @type {any} */ row) => allowed.includes(identityYard(row)))
    .map((/** @type {any} */ row) => ({ orderRef: row.ref, orderType: row.kind, status: row.status, yard: row.location }));
}

/** @param {any} order */
async function resetMember(order) {
  const t = TARGETS[order.kind];
  const local = order.kind === "co_order";
  const vrma = order.kind === "vrma_order";
  const fields = PACK_FIELDS.map((/** @type {any} */ field) => `${field}=0`);
  fields.push("confirmed_at=NULL");
  if (!local) { fields.push("confirmed=false", "loaded_qty=0", "loaded_uom=NULL"); }
  else { fields.push("confirmed_by=NULL"); }
  if (!local && !vrma) { fields.push("sync_exception=NULL", "sync_exception_at=NULL"); }
  await query(`UPDATE ${t.lines} SET ${fields.join(",")} WHERE ${t.parent}=$1 ${order.kind === "transfer_order" ? "AND line_stage='outbound'" : ""}`, [order.id]);
  const headerFields = [`${t.status}='${local ? "pending_load" : "open"}'`, "preparing_operator_id=NULL", "preparing_started_at=NULL"];
  if (!local) { headerFields.push("local_yard_order_status='Open'", "status_updated_at=clock_timestamp()"); }
  if (!local && !vrma) { headerFields.push("fulfillment_status='not_fulfilled'"); }
  if (local || vrma) { headerFields.push("loaded_at=NULL", "updated_at=clock_timestamp()"); }
  if (local) { headerFields.push("details=details-'sourceLoaded'-'sourceLoadedAt'-'sourceDeliveryOrderId'"); }
  await query(`UPDATE ${t.header} SET ${headerFields.join(",")} WHERE ${t.id}=$1`, [order.id]);
}

/** @param {{orderRef: string, actor: any, expectedStateHash: string, reason: string, requestId: string}} input */
export async function reopenOperatorOrder(input) {
  controlYards(input.actor);
  const reason = text(input.reason), requestId = text(input.requestId), expected = text(input.expectedStateHash);
  if (!reason || reason.length > 500 || !UUID.test(requestId) || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw fail("A reason, valid request ID and current preview are required.", "OPERATOR_REOPEN_INPUT", 400);
  }
  await ensureOutboundLocationDirectory();
  const inputHash = digest({ actor: input.actor.id, orderRef: text(input.orderRef), reason, expected });
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-order-reopen:${requestId}`]);
    const previous = (await query("SELECT * FROM operator_order_reopens WHERE request_id=$1", [requestId])).rows[0];
    if (previous) {
      if (previous.input_hash !== inputHash) { throw fail("This reopen request was used for different data.", "OPERATOR_REOPEN_REQUEST_REUSED"); }
      await context(input.orderRef, input.actor);
      return previous.result;
    }
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const c = await context(input.orderRef, input.actor, true);
    if (c.stateHash !== expected) { throw fail("This order changed. Refresh its preview before reopening.", "OPERATOR_REOPEN_STALE"); }
    if (c.blockers.length) { throw fail(c.blockers[0].message, c.blockers[0].code); }
    for (const order of c.orders) { await resetMember(order); }
    const refs = c.orders.map((/** @type {any} */ order) => order.ref);
    const resolved = await query(`UPDATE dispatch_operator_requests SET status='resolved',resolved_by=$2,resolved_at=now()
      WHERE status='open' AND order_ref=ANY($1::text[]) RETURNING id`, [refs, input.actor.id]);
    const correctionId = crypto.randomUUID();
    const result = { correctionId, orderRef: c.target.ref, orderRefs: refs,
      orderIds: c.orders.map((/** @type {any} */ order) => order.order_id), status: "open", retainedPhotoCount: c.photos.length,
      resolvedRequestIds: resolved.rows.map((/** @type {any} */ row) => Number(row.id)), message: "Order reopened in Operator and Dispatch. Existing images and history are retained." };
    await query(`INSERT INTO operator_order_reopens(id,request_id,target_ref,actor_operator_id,input_hash,
      expected_state_hash,reason,order_keys,before_state,retained_photo_refs,result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10::jsonb,$11::jsonb)`,
    [correctionId, requestId, c.target.ref, input.actor.id, inputHash, expected, reason, c.orders.map(orderKey),
      JSON.stringify(c.orders), JSON.stringify(c.photos), JSON.stringify(result)]);
    for (const order of c.orders) {
      await writeAudit({ actorOperatorId: input.actor.id, source: "control", action: "operator.order.reopen",
        orderId: /^-?\d+$/u.test(order.order_id || "") ? order.order_id : null,
        details: { correctionId, requestId, orderRef: order.ref, targetRef: c.target.ref, reason,
          previousStatus: order.header[TARGETS[order.kind].status], retainedPhotoCount: c.photos.length } });
    }
    return result;
  });
}
