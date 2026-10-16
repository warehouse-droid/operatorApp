export const SCM_STOCK_QUEUES = Object.freeze({request:'Request',approved:'Accepted / Awaiting SO',pending_to:'Pending TO',rejected:'Rejected',closed:'Closed'});
/** @param {unknown} value */
export function parseScmStockQueues(value) {
  if (value == null) return ['request'];
  if (value === '') return Object.keys(SCM_STOCK_QUEUES);
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
  if (!values.length) return Object.keys(SCM_STOCK_QUEUES);
  if (values.length > 64 || values.some(queue => typeof queue !== 'string' || !Object.hasOwn(SCM_STOCK_QUEUES,queue.trim().toLowerCase()))) {
    throw Object.assign(new Error('SCM stock-request queue must be Request, Pending TO, Rejected, or Closed.'),{status:400,code:'STOCK_REQUEST_QUEUE_INVALID'});
  }
  const selected = new Set(values.map(queue => String(queue).trim().toLowerCase()));
  return Object.keys(SCM_STOCK_QUEUES).filter(queue => selected.has(queue));
}
/** @param {string} [selected] */
export function scmQueueFilterHtml(selected='request') {
  const values = new Set(selected ? parseScmStockQueues(selected) : []);
  return `<details class="stock-request-yard-filter" data-yard-filter="queue" aria-label="Regular stock request queue"><summary>Queue${values.size?` (${values.size})`:': All'}</summary><div>${Object.entries(SCM_STOCK_QUEUES).map(([value,label])=>`<label><input type="checkbox" name="queue" data-scm-stock-filter="queue" value="${value}" ${values.has(value)?'checked':''}> ${label}</label>`).join('')}<div class="stock-request-filter-actions"><button type="button" data-yard-filter-clear="queue">Clear selection</button><button class="primary" type="button" data-yard-filter-apply="queue">Apply</button></div></div></details>`;
}
