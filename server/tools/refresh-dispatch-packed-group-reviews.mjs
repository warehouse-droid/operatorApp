import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDispatchPlan } from "../src/dispatch-plan-repository.js";

const fields = ["reconciliationStatus", "reconciliationApplicationStatus",
  "reconciliationBlocked", "reconciliationReason"];

function reviewFields(order, fresh) {
  assert.equal(order.id, fresh.id);
  assert.deepEqual(order.childOrders || [], fresh.childOrders || []);
  const result = { ...order };
  for (const field of fields) {
    result[field] = fresh[field] ?? (field === "reconciliationBlocked" ? false : "");
  }
  if (order.childOrderDetails?.length) {
    const children = new Map((fresh.childOrderDetails || []).map(child => [child.id, child]));
    result.childOrderDetails = order.childOrderDetails.map(child => reviewFields(child, children.get(child.id)));
  }
  return result;
}

async function currentGroup(row, apply) {
  // Lock the underlying SO rows as well so packing cannot change between
  // the authoritative read and the cache update.
  if (apply) {
    await query(`SELECT netsuite_id FROM sales_orders
      WHERE upper(tranid)=ANY($1::text[]) ORDER BY netsuite_id FOR SHARE`,
    [(row.full_order.childOrders || []).map(ref => ref.toUpperCase())]);
  }
  const plan = row.source_plan_id ? await getDispatchPlan(row.source_plan_id) : null;
  return plan?.orders?.find(order => order.id === row.group_ref);
}

async function refreshGroup(row, apply) {
  const fresh = await currentGroup(row, apply);
  if (!fresh || fresh.reconciliationBlocked || !["ok", "current"].includes(fresh.reconciliationStatus)) {
    return { kind: "retained", detail: { groupRef: row.group_ref, reason: fresh?.reconciliationReason || "No current matching group" } };
  }
  const fullOrder = reviewFields(row.full_order, fresh);
  const card = { ...row.card };
  for (const field of fields) {
    if (Object.hasOwn(card, field)) {
      card[field] = fullOrder[field];
    }
  }
  if (apply) {
    await query(`UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,updated_at=now()
      WHERE group_ref=$1`, [row.group_ref, JSON.stringify(fullOrder), JSON.stringify(card)]);
  }
  return { kind: "cleared", detail: { groupRef: row.group_ref, status: fullOrder.reconciliationApplicationStatus } };
}

export async function refreshPackedGroupReviews({ apply = false } = {}) {
  return withTransaction(async () => {
    if (!apply) {
      await query("SET TRANSACTION READ ONLY");
    }
    await query("SET LOCAL statement_timeout = '20s'");
    await query("SET LOCAL lock_timeout = '5s'");
    const candidates = (await query(`SELECT group_ref,source_plan_id,full_order,card
      FROM dispatch_global_order_groups WHERE active AND order_type='SO'
      AND full_order->>'reconciliationStatus'='review'
      AND full_order->>'reconciliationReason' LIKE 'Sales Order family reconciliation is blocked by an active operator packing draft%'
      ORDER BY group_ref ${apply ? "FOR UPDATE" : ""}`)).rows;
    const result = { apply, examined: candidates.length, cleared: [], retained: [] };
    for (const row of candidates) {
      const refreshed = await refreshGroup(row, apply);
      result[refreshed.kind].push(refreshed.detail);
    }
    return result;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await refreshPackedGroupReviews({ apply: process.argv.includes("--apply") })));
  } finally {
    await closeDb();
  }
}
