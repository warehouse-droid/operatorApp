// @ts-check
/** @param {string} message @param {number} status */
export const conversationError = (message, status) => Object.assign(new Error(message), {status});

/** @param {{message?:unknown,operationId?:unknown}} input */
export function normalizeConversationMessage(input = {}) {
  const message = typeof input.message === 'string' ? input.message.replace(/\r\n?/g, '\n').trim() : '';
  if (!message || message.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) {
    throw conversationError('Enter a message of 1–4000 characters without control characters.', 400);
  }
  const operationId = String(input.operationId || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) {
    throw conversationError('A valid message operation ID is required.', 400);
  }
  return {message, operationId};
}

/** Only these events and fields represent user-authored conversation.
 * @param {Record<string,any>} row */
export function conversationMessage(row) {
  if (row.audience && !['all', 'sales_scm'].includes(row.audience)) return null;
  const details = row.details || {};
  /** @type {Record<string,[string,unknown]>} */
  const fields = {
    stock_request_conversation_message: [details.audience, details.message],
    regular_scm_reply: ['scm', details.message],
    regular_sales_reply: ['sales', details.message],
    special_information_requested: ['scm', details.question],
    special_information_updated: ['sales', details.reply]
  };
  const field = Object.hasOwn(fields, row.event_type) ? fields[row.event_type] : null;
  if (!field || !['sales', 'scm'].includes(field[0]) || typeof field[1] !== 'string' || !field[1].trim()) return null;
  return {id: `${row.source || 'stock'}:${row.id}`, eventId: row.event_type === 'stock_request_conversation_message' ? Number(row.id) : null,
    message: field[1].trim(), audience: field[0], actorName: row.actor_name || 'User',
    createdAt: row.created_at, itemName: typeof details.itemName === 'string' ? details.itemName : ''};
}
