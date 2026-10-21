// @ts-check
import {specialPurchaseOrderDispatchReady} from './special-stock-workflow.js';

/** @typedef {Record<string,any>} RecordData */
/** @type {Readonly<Record<string,string[]>>} */
export const REGULAR_STATUSES = Object.freeze({
  pending_scm:['Pending SCM','待 SCM 处理'], pending_sales:['Pending Sales','待销售处理'],
  waiting_stock:['Waiting for Stock','等待库存'], in_progress:['In Progress','处理中'],
  completed:['Completed','已完成'], closed:['Closed','已关闭']
});
/** @type {Readonly<Record<string,string[]>>} */
export const REGULAR_OUTCOMES = Object.freeze({
  rejected:['Rejected','已拒绝'], cancelled:['Cancelled','已取消'], closed_manually:['Closed manually','手动关闭'],
  received:['Stock received','已收货'], so_updated:['SO location updated','SO 地点已更新'],
  resolved_po:['Resolved with PO','已通过采购订单解决'], so_created:['SO created','SO 已建立'],
  already_ordered:['Already Ordered','已订购'], moved_to_waitlist:['Moved to waitlist','已转入候补清单'],
  proposal:['Added to PO/TO proposal','已加入采购 / 调货建议'], released:['Released','已释放']
});
/** @type {Readonly<Record<string,string[]>>} */
export const REGULAR_WAITING_REASONS = Object.freeze({
  vendor_transfer:['Waiting for Transfer','等待调货'], production:['Waiting for Production','等待生产'],
  arrival:['Waiting for arrival','等待到货'], arrived:['Arrived','已到货']
});
/** @type {Readonly<Record<string,string[]>>} */
export const REGULAR_STATUS_DETAILS = Object.freeze({
  review:['Review required','需要审核'], awaiting_so:['Awaiting SO','等待 SO'], awaiting_po:['Awaiting PO','等待 PO'],
  sales_confirmation:['Awaiting Sales confirmation','等待销售确认'], sales_reply:['Awaiting Sales update','等待销售更新'],
  awaiting_allocation:['Awaiting allocation','等待分配'], allocation_ready:['Allocation ready for SO','已分配，可建立 SO'],
  creating_so:['Creating SO','正在建立 SO'], processing:['Processing orders','正在处理订单'],
  proposal:['Added to PO/TO proposal','已加入采购 / 调货建议'], awaiting_to:['Review and create TO','审核并建立 TO'],
  supply_wait:['Waiting for supply','等待供货'], dispatch:['Dispatch arranged','已安排发货'],
  approval_expired:['Approval expired · Re-raise or close','批准已过期 · 请重新提交或关闭'],
  processing_failed:['Processing needs attention','处理需要关注'], print_failed:['Print needs attention','打印需要处理'],
  request_complete:['Request work completed','申请处理完成'], mixed:['Mixed outcomes','多种处理结果'],
  ...REGULAR_OUTCOMES
});
const terminalStatuses = new Set(['closed','rejected','cancelled','received','fulfilled']);
const priority = ['pending_scm','pending_sales','in_progress','waiting_stock'];
/** @param {string} status @param {string} detail @param {string} [outcome] */
const state = (status,detail,outcome='') => ({status,detail,outcome});
/** @param {RecordData} request */
const isBackorder = request => request.workflowKind === 'backorder' || request.regular?.deliveryMethod === 'backorder';

/** @param {RecordData} request @param {RecordData} line */
function lineTerminal(request,line) {
  if (line.resolution || line.status === 'closed' && request.regular?.resolution) return state('completed','resolved_po','resolved_po');
  if (line.supplyStatus === 'already_ordered') return state('completed','already_ordered','already_ordered');
  if (line.status === 'received') return state('completed','received','received');
  if (line.status === 'fulfilled') return state('completed','so_updated','so_updated');
  if (line.status === 'rejected' || line.salesDecision === 'declined') return state('closed','rejected','rejected');
  if (line.status === 'cancelled') return state('closed','cancelled','cancelled');
  if (line.status === 'closed' || line.salesDecision === 'closed') {
    if (Number(line.purchase?.releasedQuantity) > 0) return state('closed','released','released');
    const moved = (request.events || []).some((/** @type {RecordData} */ event) => event.eventType === 'stocking_line_waitlisted' && Number(event.details?.lineId) === line.id);
    const outcome = moved ? 'moved_to_waitlist' : 'closed_manually';
    return state('closed',outcome,outcome);
  }
  return null;
}

/** @param {RecordData} request */
export function regularSupplyDispatchReady(request) {
  if (request.stage === 'dispatch_arrangement' || request.purchaseOrderId && specialPurchaseOrderDispatchReady(request)) return true;
  const transfers = (request.transfers || []).filter((/** @type {RecordData} */ t) => !['closed','cancelled'].includes(t.status));
  return transfers.length > 0 && transfers.every((/** @type {RecordData} */ t) => t.dispatchPlanned || t.driverCompleted || ['received','pending_receipt','partially_fulfilled'].includes(t.status));
}

/** @param {RecordData} request @param {RecordData} line */
function backorderLineState(request,line) {
  if (request.informationRequest?.status === 'pending') return state('pending_sales','sales_reply');
  if (!line.supplyStatus || line.salesDecision === 'request_update') return state('pending_scm','review');
  if (line.salesDecision !== 'accepted') return state('pending_sales','sales_confirmation');
  if (!request.salesOrderId && !request.purchaseOrderId) return state('pending_sales','awaiting_so');
  if (!request.purchaseOrderId) return state('pending_scm','awaiting_po');
  if (regularSupplyDispatchReady(request)) return state('in_progress','dispatch');
  if (!['in_stock','low_inventory'].includes(line.supplyStatus)) return state('waiting_stock','supply_wait');
  return state('in_progress','processing');
}

/** @param {RecordData} request @param {RecordData} line */
function activeLineState(request,line) {
  if (isBackorder(request)) return backorderLineState(request,line);
  const r = request.regular || {};
  const reply = line.replyStatus || (!r.stockingLines ? r.replyStatus : null);
  if (line.status === 'changes_requested' || reply === 'pending_update') return state('pending_sales','sales_reply');
  if (reply === 'pending_scm') return state('pending_scm','review');
  if (r.handoffStatus || r.pickupTransfer) return state('in_progress',regularSupplyDispatchReady(request) ? 'dispatch' : 'processing');
  if (line.status === 'submitted' || r.deliveryApproval === 'pending') return state('pending_scm','review');
  if (line.status === 'approved') {
    if (line.purchase?.demandId) return state('completed','proposal','proposal');
    if (r.deliveryMethod === 'stocking') return state('pending_scm','awaiting_to');
    if (r.deliveryVersion === 1) return state('in_progress','processing');
    return state('pending_sales','awaiting_so');
  }
  return state('in_progress',regularSupplyDispatchReady(request) ? 'dispatch' : 'processing');
}

/** @param {RecordData} request */
function waitlistState(request) {
  const w = request.waitlist || {};
  if (w.state === 'closed') {
    const outcome = w.closureType === 'rejected' ? 'rejected' : 'closed_manually';
    return state('closed',outcome,outcome);
  }
  if (w.state === 'completed') return state('completed','so_created','so_created');
  if (w.state === 'converting') return state('in_progress','creating_so');
  if (['allocated','partially_allocated'].includes(w.state)) return state('pending_sales','allocation_ready');
  return state('waiting_stock','awaiting_allocation');
}

/** @param {RecordData} request @param {ReturnType<typeof state>[]} states */
function requestState(request,states) {
  if (request.regular?.deliveryMethod === 'waitlist') return waitlistState(request);
  if (request.status === 'cancelled') return state('closed','cancelled','cancelled');
  if (request.closeStatus === 'closed' || request.stage === 'closed') {
    const outcome = states.length && states.every(s => s.outcome === 'rejected') ? 'rejected' : 'closed_manually';
    return state('closed',outcome,outcome);
  }
  if (isBackorder(request) && (request.operationallyComplete || request.stage === 'completed')) {
    const outcome = states.length && states.every(s => s.outcome === 'already_ordered') ? 'already_ordered' : '';
    return state('completed',outcome || 'request_complete',outcome);
  }
  for (const status of priority) {
    const current = states.find(s => s.status === status);
    if (current) return current;
  }
  if (states.length) {
    const completed = states.some(s => s.status === 'completed');
    const outcomes = [...new Set(states.map(s => s.outcome).filter(Boolean))];
    return state(completed ? 'completed' : 'closed',outcomes.length === 1 ? outcomes[0] : 'mixed');
  }
  return request.status === 'completed' ? state('completed','request_complete') : state('pending_scm','review');
}

/** @param {RecordData} request @param {number} now */
function expiredApproval(request,now) {
  const r = request.regular || {};
  return !['stocking','waitlist','backorder'].includes(r.deliveryMethod) && !r.pickupTransfer && !r.handoffStatus
    && r.deliveryVersion !== 1 && !!r.approvalExpiresAt && now >= Date.parse(r.approvalExpiresAt);
}

/** @param {RecordData} request */
function attentionReasons(request) {
  const r = request.regular || {}, reasons = [];
  if (r.handoffError || r.pickupTransfer?.error || request.attention || request.waitlist?.conversionNeedsAttention
    || (request.waitlist?.conversions || []).some((/** @type {RecordData} */ c) => c.error && c.status !== 'completed')) reasons.push('processing_failed');
  if ((request.transfers || []).some((/** @type {RecordData} */ t) => ['failed','uncertain','cancelled'].includes(t.printStatus))) reasons.push('print_failed');
  return reasons;
}

/** Pure display projection; never used to authorize or perform workflow actions.
 * @param {RecordData} request @param {number} [now] */
export function regularStockStatusSummary(request,now=Date.now()) {
  const seen = new Set();
  const lines = (request.lines || []).filter((/** @type {RecordData} */ line) => {
    if (line.removedAt || line.id != null && seen.has(line.id)) return false;
    if (line.id != null) seen.add(line.id);
    return true;
  });
  /** @type {ReturnType<typeof state>[]} */
  const states = request.regular?.deliveryMethod === 'waitlist' ? [waitlistState(request)]
    : lines.map((/** @type {RecordData} */ line) => lineTerminal(request,line) || activeLineState(request,line));
  const selected = requestState(request,states);
  const terminal = ['completed','closed'].includes(selected.status);
  const attention = terminal ? [] : attentionReasons(request);
  if (!terminal && expiredApproval(request,now)) {
    selected.status = 'pending_sales'; selected.detail = 'approval_expired'; attention.push('approval_expired');
  }
  const waitingReasons = terminal || regularSupplyDispatchReady(request) ? [] : Object.keys(REGULAR_WAITING_REASONS)
    .filter(reason => lines.some((/** @type {RecordData} */ line) => line.supplyStatus === reason && !terminalStatuses.has(line.status)
      && !['declined','closed'].includes(line.salesDecision) && !line.resolution));
  if (selected.status !== 'closed' && ['arrival','arrived'].includes(request.alreadyOrderedArrival?.status)) waitingReasons.push(request.alreadyOrderedArrival.status);
  const counts = Object.fromEntries(Object.keys(REGULAR_STATUSES).map(status => [status,0]));
  if (request.regular?.deliveryMethod === 'waitlist') counts[selected.status] = 1;
  else for (const row of states) counts[row.status]++;
  const outcomes = [...new Set([selected.outcome,...states.map(s => s.outcome)].filter(Boolean))];
  return {status:selected.status,detail:selected.detail,outcome:selected.outcome || (outcomes.length === 1 ? outcomes[0] : null),
    outcomes,waitingReasons,needsAttention:attention.length > 0,attentionReasons:attention,counts};
}

/** @param {RecordData} [input] */
export function parseRegularStatusFilters(input={}) {
  const allowed = {unifiedStatus:['active','all',...Object.keys(REGULAR_STATUSES)],outcome:Object.keys(REGULAR_OUTCOMES),waitingReason:Object.keys(REGULAR_WAITING_REASONS)};
  const result = {enabled:false,unifiedStatus:'all',outcome:'',waitingReason:''};
  for (const field of /** @type {Array<keyof typeof allowed>} */ (Object.keys(allowed))) {
    const value = input[field];
    if (value === undefined) continue;
    result.enabled = true;
    if (field === 'unifiedStatus' && typeof value === 'string' && value.includes(',')) {
      const choices = value.split(',').map(choice => choice.trim());
      if (choices.length <= 64 && choices.every(choice => Object.hasOwn(REGULAR_STATUSES,choice))) {
        result.unifiedStatus = Object.keys(REGULAR_STATUSES).filter(choice => choices.includes(choice)).join(',');
        continue;
      }
    }
    if (typeof value !== 'string' || value !== '' && !allowed[field].includes(value)) {
      throw Object.assign(new Error('Select a supported regular-stock status filter.'),{status:400,code:'REGULAR_STATUS_FILTER_INVALID'});
    }
    result[field] = value || (field === 'unifiedStatus' ? 'all' : '');
  }
  return result;
}

/** @param {ReturnType<typeof regularStockStatusSummary>} summary @param {ReturnType<typeof parseRegularStatusFilters>} filters */
export function matchesRegularStatusSummary(summary,filters) {
  return (filters.unifiedStatus === 'all' || (filters.unifiedStatus === 'active'
    ? !['completed','closed'].includes(summary.status) : filters.unifiedStatus.split(',').includes(summary.status)))
    && (!filters.outcome || summary.outcomes.includes(filters.outcome))
    && (!filters.waitingReason || summary.waitingReasons.includes(filters.waitingReason));
}

/** Outstanding input, including Sales lines inside a request that also needs SCM.
 * Reading a notice is deliberately independent of resolving the work.
 * @param {RecordData} request @param {number} [now] */
export function regularStockSalesAction(request,now=Date.now()) {
  const summary = regularStockStatusSummary(request,now);
  if (['completed','closed'].includes(summary.status)) return null;
  const pending = summary.status === 'pending_sales' ? summary : (request.lines || [])
    .filter((/** @type {RecordData} */ line) => !line.removedAt && !lineTerminal(request,line))
    .map((/** @type {RecordData} */ line) => activeLineState(request,line))
    .find((/** @type {ReturnType<typeof state>} */ row) => row.status === 'pending_sales');
  if (!pending) return null;
  /** @type {Record<string,string>} */
  const messages = {
    sales_reply:'SCM needs your update. Open the request to reply.',
    sales_confirmation:'Review the SCM response and confirm your decision.',
    awaiting_so:'Approval is ready. Enter the Sales Order to continue.',
    approval_expired:'Approval expired. Re-raise the request or close it if no longer needed.',
    allocation_ready:'Stock is allocated. Create the Sales Order or release the allocation.'
  };
  return {reason:pending.detail,message:messages[pending.detail] || 'This stock request needs your input.'};
}
