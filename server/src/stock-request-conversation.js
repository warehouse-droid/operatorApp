import {query, withTransaction} from './db.js';
import {getSalesStockRequest, getScmStockRequest} from './stock-request-repository.js';
import {getSpecialStockCase, submitSpecialStockInformation} from './special-stock-request-repository.js';
import {withBackorderWorkflow} from './stock-case-workflow.js';
import {getSpecialStockRequestPolicy, assertSpecialStockRequestEnabled} from './special-stock-request-policy.js';
import {stockRequestSalesScopeSql} from './regular-stock-delivery-access.js';
import {conversationError, normalizeConversationMessage, conversationMessage} from './stock-request-conversation-domain.js';

const supportedSql = `(request.request_type='special' OR (request.request_type='regular' AND request.workflow_version=2
  AND request.regular_details->>'deliveryMethod' IN ('backorder','stocking','delivery')))`;
function actor(context) {
  if (!context?.operatorId) throw conversationError('Sign in to view conversations.', 401);
  if (!['sales','scm'].includes(context.audience)) throw conversationError('Conversation access is restricted to Sales and SCM.', 403);
}
async function authorize(id, context) {
  actor(context);
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw conversationError('A valid request ID is required.', 400);
  const row = (await query(`SELECT request.* FROM sales_stock_requests request WHERE id=$1 AND ${supportedSql}`, [id])).rows[0];
  if (!row) throw conversationError('Request conversation not found.', 404);
  const special = row.request_type === 'special', backorder = row.regular_details?.deliveryMethod === 'backorder';
  const run = fn => backorder ? withBackorderWorkflow(fn) : fn();
  let detail;
  if (special || backorder) {
    assertSpecialStockRequestEnabled(await getSpecialStockRequestPolicy());
    detail = await run(() => getSpecialStockCase(id, {audience: context.audience,
      ...(context.audience === 'sales' ? {authorizedStoreLocationIds: context.authorizedDestinationLocationIds || []} : {})}));
  } else {
    detail = await (context.audience === 'sales' ? getSalesStockRequest(id, {authorizedDestinationLocationIds: context.authorizedDestinationLocationIds || []}) : getScmStockRequest(id));
  }
  const canSend = !['closed','completed','cancelled','rejected'].includes(row.status) && !detail.operationallyComplete
    && !['closed','completed'].includes(detail.stage) && (!detail.closeStatus || detail.closeStatus === 'active') && !detail.regular?.resolution;
  return {row, detail, run, canSend};
}
async function history(id, canSend) {
  const result = await query(`SELECT journal.*, COALESCE(operator.display_name,operator.username) AS actor_name FROM (
    SELECT id,'stock' AS source,event_type,actor_id,details,created_at,NULL::text AS audience
      FROM sales_stock_request_events WHERE request_id=$1 AND event_type IN ('stock_request_conversation_message','regular_scm_reply','regular_sales_reply')
    UNION ALL
    SELECT legacy.id,'special' AS source,legacy.event_type,legacy.actor_id,legacy.details,legacy.created_at,legacy.audience
      FROM sales_special_stock_events legacy WHERE legacy.request_id=$1
        AND legacy.event_type IN ('special_information_requested','special_information_updated') AND legacy.audience IN ('all','sales_scm')
        AND NOT EXISTS(SELECT 1 FROM sales_stock_request_events message WHERE message.request_id=$1 AND message.event_type='stock_request_conversation_message'
          AND message.details->>'legacySpecialEventId'=legacy.id::text)
    ) journal LEFT JOIN operators operator ON operator.id=journal.actor_id ORDER BY journal.created_at DESC,journal.id DESC LIMIT 200`, [id]);
  const messages = result.rows.reverse().map(conversationMessage).filter(Boolean);
  return {messages, canSend, latestEventId: Math.max(0, ...messages.map(message => message.eventId || 0))};
}
export async function listStockRequestConversation(id, context) {
  const access = await authorize(id, context);
  return history(id, access.canSend);
}
async function resolveLegacyHold(id, access, message, context) {
  if (context.audience === 'sales' && access.detail.informationRequest?.status === 'pending') {
    await access.run(() => submitSpecialStockInformation(id, {expectedRevision: access.detail.revision, reply: message},
      {operatorId: context.operatorId, authorizedStoreLocationIds: context.authorizedDestinationLocationIds || []}));
    const legacy = (await query("SELECT id FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_information_updated' ORDER BY id DESC LIMIT 1", [id])).rows[0];
    return {workflowUpdated: true, legacySpecialEventId: String(legacy.id)};
  }
  const regular = access.row.regular_details;
  if (regular?.deliveryMethod !== 'stocking') return {workflowUpdated: false};
  const from = context.audience === 'sales' ? 'pending_update' : 'pending_scm';
  const to = context.audience === 'sales' ? 'pending_scm' : null;
  let changed = regular.replyStatus === from;
  const stockingLines = {...regular.stockingLines};
  for (const [key, line] of Object.entries(stockingLines)) {
    if (line.replyStatus === from) {stockingLines[key] = {...line, replyStatus: to}; changed = true;}
  }
  if (changed) {
    const statuses = Object.values(stockingLines).map(line => line.replyStatus);
    const replyStatus = statuses.includes('pending_scm') ? 'pending_scm' : statuses.includes('pending_update') ? 'pending_update' : to;
    await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now(),regular_details=regular_details||$2::jsonb WHERE id=$1',
      [id, JSON.stringify({stockingLines, replyStatus})]);
  }
  return {workflowUpdated: changed};
}
export async function sendStockRequestConversation(id, input, context) {
  actor(context);
  const payload = normalizeConversationMessage(input);
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw conversationError('A valid request ID is required.', 400);
  return withTransaction(async () => {
    // Share the request lock with workflow edits so a close and a send cannot cross.
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE', [id]);
    const access = await authorize(id, context);
    const existing = (await query(`SELECT details FROM sales_stock_request_events WHERE request_id=$1 AND event_type='stock_request_conversation_message'
      AND actor_id=$2 AND details->>'audience'=$3 AND details->>'operationId'=$4`, [id, context.operatorId, context.audience, payload.operationId])).rows[0];
    if (existing) {
      if (existing.details.message !== payload.message) throw conversationError('This message operation was already used for different text.', 409);
      return {...await history(id, access.canSend), workflowUpdated: false};
    }
    if (!access.canSend) throw conversationError('This request is closed. Its conversation is read-only.', 409);
    const legacy = await resolveLegacyHold(id, access, payload.message, context);
    await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
      VALUES($1,'stock_request_conversation_message',$2,$3::jsonb)`, [id, context.operatorId, JSON.stringify({...payload, audience: context.audience,
        ...(legacy.legacySpecialEventId ? {legacySpecialEventId: legacy.legacySpecialEventId} : {})})]);
    return {...await history(id, access.canSend), workflowUpdated: legacy.workflowUpdated};
  });
}
export async function readStockRequestConversation(id, input, context) {
  await authorize(id, context);
  const eventId = Number(input?.eventId);
  if (!Number.isSafeInteger(eventId) || eventId <= 0 || !(await query(`SELECT 1 FROM sales_stock_request_events
    WHERE id=$1 AND request_id=$2 AND event_type='stock_request_conversation_message'`, [eventId, id])).rowCount) {
    throw conversationError('Select a message from this conversation to mark it read.', 400);
  }
  await query(`INSERT INTO stock_request_conversation_reads(request_id,operator_id,read_event_id) VALUES($1,$2,$3)
    ON CONFLICT(request_id,operator_id) DO UPDATE SET read_event_id=GREATEST(stock_request_conversation_reads.read_event_id,EXCLUDED.read_event_id),updated_at=now()`,
    [id, context.operatorId, eventId]);
  return {ok: true};
}
export async function listStockRequestConversationAlerts(context) {
  actor(context);
  const policy = await getSpecialStockRequestPolicy();
  let enabled = true;
  try {assertSpecialStockRequestEnabled(policy);} catch {enabled = false;}
  const result = await query(`WITH unread AS (
    SELECT request.id,request.request_ref,request.request_type,event.id AS event_id,event.details,event.created_at,
      COALESCE(operator.display_name,operator.username) AS actor_name
    FROM sales_stock_request_events event JOIN sales_stock_requests request ON request.id=event.request_id
    LEFT JOIN operators operator ON operator.id=event.actor_id
    LEFT JOIN stock_request_conversation_reads receipt ON receipt.request_id=request.id AND receipt.operator_id=$1
    WHERE event.event_type='stock_request_conversation_message' AND event.details->>'audience'=$2 AND event.actor_id<>$1
      AND event.id>COALESCE(receipt.read_event_id,0) AND ${supportedSql}
      AND ($3 OR (request.request_type='regular' AND request.regular_details->>'deliveryMethod'<>'backorder'))
      ${context.audience === 'sales' ? `AND ${stockRequestSalesScopeSql('$4')}` : ''}
    ), ranked AS (SELECT *,count(*) OVER(PARTITION BY id) AS unread_count,row_number() OVER(PARTITION BY id ORDER BY event_id DESC) AS rank FROM unread)
    SELECT *,sum(unread_count) OVER() AS total FROM ranked WHERE rank=1 ORDER BY event_id DESC LIMIT 100`,
    [context.operatorId, context.audience === 'sales' ? 'scm' : 'sales', enabled, ...(context.audience === 'sales' ? [context.authorizedDestinationLocationIds || []] : [])]);
  return {count: Number(result.rows[0]?.total || 0), requests: result.rows.map(row => ({id: Number(row.id), requestRef: row.request_ref,
    tab: row.request_type === 'special' ? 'special' : 'regular', latestEventId: Number(row.event_id), unreadCount: Number(row.unread_count),
    message: row.details.message, actorName: row.actor_name, createdAt: row.created_at}))};
}
