// @ts-check
import {query} from './db.js';
import {regularError} from './regular-stock-domain.js';

/** @template {{id:number}} T @param {{lines:T[]}} request @param {unknown} value @param {string} code */
export function stockingActionLine(request,value,code) {
  if(value===undefined&&request.lines.length===1)return request.lines[0];
  if(!['number','string'].includes(typeof value)||!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value))) {
    throw regularError('Choose one material line.',code,400);
  }
  const line=request.lines.find(line=>line.id===Number(value));
  if(!line)throw regularError('This material does not belong to the request.',code,400);
  return line;
}

/** @param {{regular?:{stockingLines?:Record<string,Record<string,unknown>>}}} request @param {number} lineId @param {Record<string,unknown>} changes */
export function stockingLineState(request,lineId,changes) {
  const states={...request.regular?.stockingLines};
  states[lineId]={...states[lineId],...changes};
  return states;
}

/** Keep the queue's waiting marker consistent with open line conversations. @param {number|string|number[]} requestId */
export async function refreshStockingReplyStatus(requestId) {
  const ids=Array.isArray(requestId)?requestId:[Number(requestId)];
  await query(`UPDATE sales_stock_requests r SET regular_details=jsonb_set(r.regular_details,'{replyStatus}',
    COALESCE((SELECT to_jsonb(state.value->>'replyStatus') FROM jsonb_each(COALESCE(r.regular_details->'stockingLines','{}'::jsonb)) state
      JOIN sales_stock_request_lines l ON l.request_id=r.id AND l.id::text=state.key
      WHERE l.status NOT IN ('closed','rejected','cancelled','received','fulfilled') AND state.value->>'replyStatus' IN ('pending_scm','pending_update')
      ORDER BY CASE state.value->>'replyStatus' WHEN 'pending_scm' THEN 0 ELSE 1 END LIMIT 1),'null'::jsonb))
    WHERE r.id=ANY($1::bigint[]) AND r.regular_details ? 'stockingLines'`,[ids]);
}

/** @param {number|string} requestId @param {number[]} lineIds */
export async function clearStockingLineReplies(requestId,lineIds) {
  await query(`UPDATE sales_stock_requests r SET regular_details=jsonb_set(r.regular_details,'{stockingLines}',
    (SELECT jsonb_object_agg(state.key,CASE WHEN state.key=ANY($2::text[]) THEN state.value||'{"replyStatus":null}'::jsonb ELSE state.value END)
      FROM jsonb_each(r.regular_details->'stockingLines') state))
    WHERE r.id=$1 AND r.regular_details ? 'stockingLines' AND r.regular_details->'stockingLines'<>'{}'::jsonb`,[requestId,lineIds.map(String)]);
  await refreshStockingReplyStatus(requestId);
}
