// @ts-check
import {query} from '../db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../dispatch-fleet-status.js';
import {executeMbtCommand} from './command-repository.js';
import {transportError} from './bin-transport-domain.js';

/** @param {any} [input] */
export async function listAggregateRouting(input={}) {
  const search=String(input.search || '').trim().slice(0,120),limit=Math.min(100,Math.max(1,Number(input.limit)||50));
  const {rows}=await query(`SELECT COALESCE(i.item_id,r.item_id)::text AS "itemId",
    COALESCE(i.item_name,'Catalog item '||r.item_id::text) AS name,i.display_name AS "displayName",i.stock_unit AS unit,
    CASE WHEN i.item_id IS NULL THEN false ELSE lower(COALESCE(i.raw->>'isinactive',i.raw->>'isInactive','false')) NOT IN ('t','true','1') END AS active,
    COALESCE(r.bin_only,false) AS "binOnly",COALESCE(r.revision,0)::int AS revision,
    COALESCE((SELECT jsonb_agg(c.order_ref) FROM (SELECT order_ref FROM dispatch_order_catalog_entries c
      WHERE EXISTS(SELECT 1 FROM jsonb_path_query(c.full_order,'$.**.items[*].itemId') item
        WHERE item #>> '{}' = COALESCE(i.item_id,r.item_id)::text) ORDER BY order_ref LIMIT 20) c),'[]'::jsonb) AS "affectedOrders"
    FROM inventory_items i FULL JOIN mbt_aggregate_routing_items r USING(item_id)
    WHERE $1='' OR concat_ws(' ',i.item_id,r.item_id,i.item_name,i.display_name) ILIKE '%'||$1||'%'
    ORDER BY COALESCE(r.bin_only,false) DESC,COALESCE(i.item_name,r.item_id::text) LIMIT $2`,[search,limit]);
  return {items:rows};
}

/** @param {any} input */
export async function saveAggregateRouting(input) {
  if (!input.actor?.operatorId || !input.actor.roles?.includes('admin')) {
    throw Object.assign(transportError('Admin access is required for Aggregate Routing.'),{status:403});
  }
  if (!/^[1-9]\d{0,14}$/u.test(String(input.itemId)) || typeof input.binOnly!=='boolean'
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0) {
    throw transportError('Choose a catalog item, routing setting and current revision.');
  }
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  return executeMbtCommand({actor,idempotencyKey,correlationId,requestId,commandName:'mbt.aggregate_routing.save',payload,
    mutation:async()=>{
      await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
      const before=(await query('SELECT * FROM mbt_aggregate_routing_items WHERE item_id=$1 FOR UPDATE',[input.itemId])).rows[0];
      if (Number(before?.revision || 0)!==input.expectedRevision) {throw transportError('Aggregate routing changed. Refresh before saving.');}
      if (!(await query('SELECT 1 FROM inventory_items WHERE item_id=$1',[input.itemId])).rowCount) {throw transportError('Select an imported catalog item.');}
      const saved=(await query(`INSERT INTO mbt_aggregate_routing_items(item_id,bin_only,updated_by) VALUES($1,$2,$3)
        ON CONFLICT(item_id) DO UPDATE SET bin_only=EXCLUDED.bin_only,revision=mbt_aggregate_routing_items.revision+1,
        updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING item_id::text AS "itemId",bin_only AS "binOnly",revision`,
      [input.itemId,input.binOnly,actor.operatorId])).rows[0];
      return {status:200,body:saved,audit:{action:'mbt.aggregate_routing.changed',entityType:'mbt_aggregate_routing_item',
        entityId:String(input.itemId),beforeState:before || {},afterState:saved,reason:'Admin changed BIN aggregate routing',
        revisionBefore:input.expectedRevision || 1,revisionAfter:saved.revision,source:'mbt-config'}};
    }});
}

export async function aggregateRoutingIds() {
  return new Set((await query('SELECT item_id::text FROM mbt_aggregate_routing_items WHERE bin_only ORDER BY item_id')).rows.map((/** @type {any} */ r)=>r.item_id));
}
