// Verify current, authenticated catalog browse without changing orders or plans.
// The normal catalog worker handles the requested read-projection refresh.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { query, withTransaction, closeDb } from "../src/db.js";
import { enqueueDispatchOrderCatalogRefresh, getDispatchOrderCatalogState } from "../src/dispatch-order-catalog-repository.js";
import { listFulfilledTransferStates } from "../src/dispatch-fulfilled-to-repository.js";

const refs = ["TOB01164", "TOB01163"];
const types = ["SO", "PO", "TO", "CO", "CUSTOM"];
const id = randomUUID();
const username = `dispatch-recent-cards-check-${id}`;
const auth = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(auth).digest("hex");
const epoch = "1970-01-01T00:00:00.000Z";
const httpTimeoutMs = 60000;
const refreshTimeoutMs = 180000;
const result = { passed: false, requests: [], sourceHashesUnchanged: false,
  diagnosticRecordsRemoved: false, epochDateCount: null, unknownArrivalCount: null,
  limits: { pageSize: 200, httpTimeoutMs, refreshTimeoutMs },
  excludedSourceMetadata: ["first_seen_at"], timestampPrecision: "milliseconds" };
const instant = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const key = value => String(value || "").trim().toLowerCase();
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function snapshot() {
  return withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const transfers = (await query(`SELECT t.tranid,
      md5(jsonb_build_object('order',to_jsonb(t)-'first_seen_at','lines',
        (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_stage,l.id)
           FROM transfer_order_lines l WHERE l.transfer_order_id=t.netsuite_id))::text) AS hash
      FROM transfer_orders t WHERE t.tranid=ANY($1::text[]) ORDER BY t.tranid`, [refs])).rows;
    const structures = (await query(`SELECT 'savedPlans' AS structure,count(*)::int AS rows,
        md5(COALESCE(string_agg(md5(to_jsonb(p)::text),'' ORDER BY p.id),'')) AS hash FROM dispatch_plans p
      UNION ALL SELECT 'savedSnapshots',count(*)::int,
        md5(COALESCE(string_agg(md5(to_jsonb(s)::text),'' ORDER BY s.plan_id),'')) FROM dispatch_plan_snapshots s
      UNION ALL SELECT 'loadAssignments',count(*)::int,
        md5(COALESCE(string_agg(md5(to_jsonb(l)::text),'' ORDER BY l.id),'')) FROM dispatch_plan_load_assignments l
      UNION ALL SELECT 'savedLoads',count(*)::int,
        md5(COALESCE(string_agg(md5(jsonb_build_object('planId',s.plan_id,'truck',truck.value->>'id',
          'truckPlate',truck.value->>'plate','load',load.value)::text),''
          ORDER BY s.plan_id,truck.position,load.position),''))
        FROM dispatch_plan_snapshots s
        CROSS JOIN LATERAL jsonb_array_elements(s.trucks) WITH ORDINALITY AS truck(value,position)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value->'loads','[]'::jsonb))
          WITH ORDINALITY AS load(value,position)
      ORDER BY structure`)).rows;
    return { transfers, structures };
  });
}

async function recencyEvidence() {
  const rows = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='60s'");
    return (await query(`WITH mirror AS MATERIALIZED (
      SELECT 'sales_orders'::text AS source_table,netsuite_id::text AS record_id,lower(tranid) AS ref_key,first_seen_at FROM sales_orders
      UNION ALL SELECT 'purchase_orders',netsuite_id::text,lower(tranid),first_seen_at FROM purchase_orders
      UNION ALL SELECT 'transfer_orders',netsuite_id::text,lower(tranid),first_seen_at FROM transfer_orders
    ), leaf_catalog AS MATERIALIZED (
      SELECT catalog.order_ref,catalog.order_type,catalog.eligible,catalog.activity_at,
        catalog.card->>'firstSeenAt' AS card_arrival,catalog.full_order->>'firstSeenAt' AS full_arrival,
        COALESCE(NULLIF(catalog.full_order->>'sourceTable',''),catalog.full_order->'raw'->>'source_table') AS source_table,
        COALESCE(NULLIF(catalog.full_order->>'netsuiteId',''),NULLIF(catalog.full_order->>'sourceRecordId',''),
          NULLIF(catalog.full_order->'raw'->>'netsuite_id','')) AS record_id
        FROM dispatch_order_catalog_entries catalog
       WHERE CASE WHEN jsonb_typeof(catalog.full_order->'childOrders')='array'
              THEN jsonb_array_length(catalog.full_order->'childOrders') ELSE 0 END=0
    ) SELECT catalog.order_ref,catalog.order_type,catalog.eligible,catalog.activity_at::text,
        catalog.card_arrival,catalog.full_arrival,
        COALESCE(by_id.record_id,by_ref.record_id) AS record_id,
        COALESCE(by_id.first_seen_at,by_ref.first_seen_at)::text AS authoritative_arrival
      FROM leaf_catalog catalog LEFT JOIN mirror by_id
        ON by_id.source_table=catalog.source_table AND by_id.record_id=catalog.record_id
      LEFT JOIN mirror by_ref
        ON by_ref.source_table=catalog.source_table AND catalog.record_id IS NULL
       AND by_ref.ref_key=lower(catalog.order_ref)
     WHERE catalog.source_table IN ('sales_orders','purchase_orders','transfer_orders')
     ORDER BY catalog.order_type,catalog.order_ref`)).rows;
  });
  const orphaned = rows.filter(row => !row.record_id);
  const unknown = rows.filter(row => instant(row.authoritative_arrival) === epoch);
  const known = rows.filter(row => row.record_id && instant(row.authoritative_arrival) !== epoch);
  const missing = known.filter(row => !instant(row.card_arrival) || !instant(row.full_arrival));
  const mismatch = rows.filter(row => row.record_id && (
    instant(row.card_arrival) !== instant(row.authoritative_arrival)
    || instant(row.full_arrival) !== instant(row.authoritative_arrival)
    || instant(row.activity_at) !== instant(row.authoritative_arrival)));
  const incorrectEpoch = known.filter(row => instant(row.activity_at) === epoch);
  return { mirrorLeafRows: rows.length, knownArrivalCount: known.length,
    unknownArrivalCount: unknown.length, epochDateCount: incorrectEpoch.length,
    missingKnownArrivalCount: missing.length, mismatchCount: mismatch.length,
    orphanedMirrorCount: orphaned.length,
    missingKnownArrivalRefs: missing.map(row => row.order_ref),
    mismatchRefs: mismatch.map(row => row.order_ref), orphanedMirrorRefs: orphaned.map(row => row.order_ref) };
}

async function waitForNormalRefresh() {
  const requestedAt = Date.now();
  const refresh = await enqueueDispatchOrderCatalogRefresh({ source: username });
  result.catalogRefresh = { id: refresh.id, requestedAt: new Date(requestedAt).toISOString(), polls: 0 };
  for (;;) {
    const state = await getDispatchOrderCatalogState();
    const row = (await query("SELECT status,attempts,last_error,completed_at FROM dispatch_order_catalog_refresh_outbox WHERE id=$1::bigint", [refresh.id])).rows[0];
    const evidence = await recencyEvidence();
    result.catalogRefresh.polls += 1;
    result.catalogState = state;
    result.catalogRefresh.status = row?.status || "missing";
    result.catalogRefresh.lastError = row?.last_error || "";
    result.catalogRecency = evidence;
    if (row?.status === "complete" && state.ready && state.assignmentsReady
      && evidence.mirrorLeafRows > 0
      && evidence.missingKnownArrivalCount === 0 && evidence.mismatchCount === 0
      && evidence.orphanedMirrorCount === 0) {
      result.catalogRefresh.ms = Date.now() - requestedAt;
      result.epochDateCount = evidence.epochDateCount;
      result.unknownArrivalCount = evidence.unknownArrivalCount;
      assert.equal(evidence.epochDateCount, 0);
      return;
    }
    assert.ok(Date.now() - requestedAt < refreshTimeoutMs,
      `Normal catalog refresh did not become ready: ${JSON.stringify({ state, refresh: row, evidence })}`);
    await pause(1000);
  }
}

async function activityByRef() {
  const rows = (await query(`WITH dates AS (SELECT order_ref,activity_at,2 AS priority FROM dispatch_order_catalog_entries
    UNION ALL SELECT split_ref,COALESCE(NULLIF(card->>'firstSeenAt','')::timestamptz,date_trunc('milliseconds',created_at)),1
      FROM dispatch_global_order_splits WHERE active=true
    UNION ALL SELECT group_ref,COALESCE(NULLIF(card->>'firstSeenAt','')::timestamptz,date_trunc('milliseconds',created_at)),0
      FROM dispatch_global_order_groups WHERE active=true
    ), chosen AS (
      SELECT DISTINCT ON (lower(order_ref)) order_ref,activity_at
        FROM dates ORDER BY lower(order_ref),priority
    ) SELECT order_ref,activity_at::text,
        row_number() OVER (ORDER BY activity_at DESC,lower(order_ref) DESC)::int AS arrival_rank
      FROM chosen`)).rows;
  return new Map(rows.map(row => [key(row.order_ref), { date: instant(row.activity_at), rank: row.arrival_rank }]));
}

function assertPageOrder(orders, activities) {
  const sorted = orders.map(order => {
    const arrival = instant(order.firstSeenAt);
    const activity = activities.get(key(order.id));
    assert.ok(activity?.date, `No catalog ordering date for ${order.id}`);
    if (arrival) assert.equal(arrival, activity.date, `${order.id}: card arrival differs from catalog ordering date`);
    return { id: order.id, key: key(order.id), date: arrival || activity.date,
      rank: activity.rank, known: Boolean(arrival) };
  });
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1], current = sorted[index];
    assert.ok(previous.rank < current.rank,
      `Nonmonotonic arrival page: ${previous.id} (${previous.date}) before ${current.id} (${current.date})`);
  }
  return sorted;
}

async function browse(type, cursor = "", previous = []) {
  const params = new URLSearchParams({ type, limit: "200" });
  if (cursor) params.set("cursor", cursor);
  const path = `/api/dispatch/v2/order-pool?${params}`;
  const started = performance.now();
  result.attempt = { type, continuation: Boolean(cursor), path, startedAt: new Date().toISOString() };
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    headers: { authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(httpTimeoutMs)
  });
  const payload = await response.json();
  const record = { type, continuation: Boolean(cursor), path, status: response.status,
    ms: Math.round(performance.now() - started), source: payload.source,
    catalogRevision: payload.catalogRevision, returned: payload.orders?.length || 0 };
  result.requests.push(record);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.source, "catalog", "Live verification must exercise the optimized catalog");
  assert.ok(Array.isArray(payload.orders));
  assert.ok(payload.orders.length <= 200);
  const activities = await activityByRef();
  const sorted = assertPageOrder(payload.orders, activities);
  assert.equal(new Set(sorted.map(row => row.key)).size, sorted.length, "Duplicate card on a page");
  if (previous.length && sorted.length) assertPageOrder([previous.at(-1), payload.orders[0]], activities);
  const previousRefs = new Set(previous.map(order => key(order.id)));
  assert.ok(payload.orders.every(order => !previousRefs.has(key(order.id))), "Continuation repeats an earlier card");
  record.orderIds = payload.orders.map(order => order.id);
  record.arrivals = sorted.map(row => ({ id: row.id, firstSeenAt: row.known ? row.date : null,
    sortDate: row.date, metadataPresent: row.known }));
  record.unknownLegacyDerivedArrivalCards = sorted.filter(row => !row.known).map(row => row.id);
  record.hasNextCursor = Boolean(payload.nextCursor);
  record.nextCursor = payload.nextCursor || "";
  return payload;
}

async function transferDetails(toPage) {
  const toOrders = toPage.orders;
  const states = await listFulfilledTransferStates(refs);
  const rows = (await query(`SELECT t.tranid,t.netsuite_id::text,t.first_seen_at::text,t.trandate::text,
      t.status,t.status_text,t.netsuite_active,catalog.eligible AS catalog_eligible,
      catalog.activity_at::text,catalog.card->>'firstSeenAt' AS card_arrival,
      catalog.full_order->>'dispatchFulfilledTransferPlanningEligible' AS catalog_fulfilled_eligible,
      catalog.full_order->>'dispatchPlanningRestricted' AS catalog_planning_restricted,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('planId',assignment.plan_id,'date',assignment.plan_date,
          'loadId',assignment.load_id) ORDER BY assignment.plan_date,assignment.plan_id),'[]'::jsonb)
         FROM dispatch_plan_order_assignments assignment JOIN dispatch_plans plan ON plan.id=assignment.plan_id
        WHERE lower(assignment.order_ref)=lower(t.tranid) AND plan.status<>'cancelled') AS assignments,
      EXISTS(SELECT 1 FROM dispatch_global_order_group_members member JOIN dispatch_global_order_groups g
        ON g.group_ref=member.group_ref WHERE g.active=true AND member.hides_member=true
          AND lower(member.member_order_ref)=lower(t.tranid)) AS hidden_by_group,
      EXISTS(SELECT 1 FROM dispatch_global_order_splits split WHERE split.active=true
        AND split.definition_kind='split' AND lower(split.parent_order_ref)=lower(t.tranid)) AS hidden_by_split
      FROM transfer_orders t LEFT JOIN dispatch_order_catalog_entries catalog ON lower(catalog.order_ref)=lower(t.tranid)
      WHERE t.tranid=ANY($1::text[]) ORDER BY t.tranid`, [refs])).rows;
  return rows.map(row => {
    const state = states.get(key(row.tranid));
    const card = toOrders.find(order => key(order.id) === key(row.tranid));
    const expectedCatalogCandidate = state?.eligible === true && row.assignments.length === 0
      && !row.hidden_by_group && !row.hidden_by_split;
    if (expectedCatalogCandidate) assert.equal(row.catalog_eligible, true, `${row.tranid}: eligible unplanned transfer absent from catalog`);
    if (expectedCatalogCandidate && !toPage.nextCursor) assert.ok(card, `${row.tranid}: eligible unplanned transfer absent from complete first TO page`);
    if (card && state?.eligible === true) {
      assert.equal(card.dispatchFulfilledTransferPlanningEligible, true, `${row.tranid}: initial card lost fulfilled-transfer eligibility`);
      assert.notEqual(card.dispatchPlanningRestricted, true);
    }
    if (row.assignments.length) assert.equal(Boolean(card), false, `${row.tranid}: already planned transfer appears in default browse`);
    return { ...row, planningState: state || null, firstPagePresent: Boolean(card), expectedCatalogCandidate,
      expectedFirstPagePresent: expectedCatalogCandidate && !toPage.nextCursor,
      firstPagePlanningEligible: card?.dispatchFulfilledTransferPlanningEligible === true };
  });
}

let failure;
try {
  result.planStructures = (await query(`SELECT table_name,column_name,data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`,
  [["dispatch_plans", "dispatch_plan_snapshots", "dispatch_plan_load_assignments"]])).rows;
  const before = await snapshot();
  result.beforeHashes = before;
  assert.equal(before.transfers.length, 2, "Both reported transfers must exist");
  await withTransaction(async () => {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
      VALUES($1,$2,'Temporary Dispatch recent-card verification',$3,$4,'dispatcher',ARRAY['dispatcher'],true)`,
    [id, username, randomBytes(64).toString("hex"), randomBytes(32).toString("hex")]);
    await query(`INSERT INTO operator_sessions(token_hash,operator_id,expires_at)
      VALUES($1,$2,now()+interval '15 minutes')`, [tokenHash, id]);
  });
  await waitForNormalRefresh();
  const pages = new Map();
  for (const type of types) pages.set(type, await browse(type));
  const continuationType = types.find(type => pages.get(type).nextCursor);
  if (continuationType) {
    const first = pages.get(continuationType);
    const next = await browse(continuationType, first.nextCursor, first.orders);
    assert.ok(next.orders.length > 0, "Advertised continuation must return older cards");
    result.continuation = { exercised: true, type: continuationType, returned: next.orders.length };
  } else result.continuation = { exercised: false, reason: "Every eligible type fits on its first page" };
  result.transfers = await transferDetails(pages.get("TO"));
  result.afterHashes = await snapshot();
  assert.deepEqual(result.afterHashes, before, "Verification changed transfer orders/lines or saved plans/loads");
  result.sourceHashesUnchanged = true;
  result.passed = true;
} catch (error) {
  failure = error;
  result.error = { name: error.name, message: error.message };
} finally {
  try {
    await withTransaction(async () => {
      await query("DELETE FROM operator_sessions WHERE operator_id=$1 AND token_hash=$2", [id, tokenHash]);
      await query("DELETE FROM operators WHERE id=$1 AND username=$2", [id, username]);
    });
    const cleanup = (await query(`SELECT (SELECT count(*) FROM operators WHERE id=$1 AND username=$2)
      +(SELECT count(*) FROM operator_sessions WHERE operator_id=$1 AND token_hash=$3) AS count`, [id, username, tokenHash])).rows[0];
    result.diagnosticRecordsRemoved = cleanup.count === "0";
    assert.equal(result.diagnosticRecordsRemoved, true);
  } catch (error) {
    failure ||= error;
    result.cleanupError = { name: error.name, message: error.message };
    result.passed = false;
  }
  try { await closeDb(); } catch (error) {
    failure ||= error;
    result.closeError = { name: error.name, message: error.message };
    result.passed = false;
  }
  console.log(JSON.stringify(result));
}
if (failure) throw failure;
