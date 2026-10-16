// The partial conversation index supplies one event per request. Sort before
// pagination without changing workflow revisions or request timestamps.
export const conversationQueueActivitySql = `COALESCE((
  SELECT message.id FROM sales_stock_request_events message
  WHERE message.request_id=request.id AND message.event_type='stock_request_conversation_message'
  ORDER BY message.id DESC LIMIT 1
),0) AS conversation_event_id`;
