// @ts-check
import {createHash} from 'node:crypto';
import {specialDispatchPlanning} from './special-stock-planning.js';
import {specialPurchaseOrderDisplayRef} from '../public/special-stock-po-reference.js';

/** @typedef {Record<string,any>} Row */
/** @param {Row|null} order */
export function activeBackorderPurchaseOrder(order) {
  return !!order && order.netsuite_active !== false
    && !['cancelled','canceled','rejected'].includes(String(order.status_text || '').trim().toLowerCase().replace(/^purchase order\s*:\s*/,''));
}

/** Canonical PO evidence; a saved optional reference is never alert evidence.
 * @param {Row|null} order @param {Row[]} plans */
export function backorderPurchaseOrderProgress(order,plans) {
  if (!activeBackorderPurchaseOrder(order)) return {poRefNumber:'',planned:false,plans:[],notices:[]};
  const po=/** @type {Row} */(order),purchaseOrderId=Number(po.netsuite_id);
  const poRefNumber=String(po.dispatch_ref || '').trim();
  const displayRef=specialPurchaseOrderDisplayRef({purchaseOrderRef:po.tranid,purchaseOrderReference:poRefNumber});
  const planning=specialDispatchPlanning({purchaseOrderId,purchaseOrderRef:po.tranid,purchaseOrderReference:poRefNumber},plans).purchaseOrder;
  // Native and vendor references can point to the same assignment.
  const assignments=[...new Map(planning.plans.map(plan=>[JSON.stringify([plan.planId,plan.planDate,plan.truck,plan.load]),plan])).values()];
  /** @type {Row[]} */
  const notices=[];
  /** @param {string} action @param {unknown} identity @param {string} message */
  const add=(action,identity,message)=>notices.push({action,purchaseOrderId,purchaseOrderRef:displayRef,message,
    noticeKey:createHash('sha256').update(JSON.stringify([action,purchaseOrderId,identity])).digest('hex')});
  if (poRefNumber) add('po_reference',poRefNumber.toUpperCase(),`PO reference available · ${displayRef}`);
  // Ignore ETA, truck, sync timestamps and request edits when deduplicating a plan notice.
  const schedules=[...new Set(assignments.map(plan=>JSON.stringify([plan.planId,plan.planDate])))].sort();
  if (schedules.length) add('po_planned',schedules,`PO planned · ${displayRef} · ${[...new Set(assignments.map(plan=>plan.planDate))].sort().join(', ')}`);
  return {poRefNumber,planned:planning.planned,plans:assignments,notices};
}
