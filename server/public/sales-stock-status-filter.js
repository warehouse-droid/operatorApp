/** The request statuses Sales sees, followed by the per-material stock checks.
 * @type {Readonly<Record<string,string[]>>} */
export const SALES_STOCK_STATUSES = Object.freeze({
  pending: ['Pending', '待处理'],
  accepted: ['Accepted', '已接受'],
  new_enquiry: ['New enquiry', '新申请'],
  pending_update: ['Pending Update', '待更新'],
  pending_scm: ['Pending SCM review', '待 SCM 审核'],
  await_customer_confirmation: ['Await Sales confirmation', '待销售确认'],
  confirmed: ['Confirmed', '已确认'],
  dispatch_arrangement: ['Dispatch Arrangement', '安排发货'],
  wait_for_production: ['Wait for production / Transfer', '待生产 / 调货'],
  proposed: ['Added to PO/TO proposal', '已加入采购 / 调货建议'],
  partially_proposed: ['Partially added to PO/TO proposal', '部分已加入采购 / 调货建议'],
  changes_requested: ['Request Change', '要求修改'],
  expired: ['Approval expired', '批准已过期'],
  resolved: ['Resolved', '已解决'],
  cancelled: ['Cancelled', '已取消'],
  closed: ['Closed', '已关闭'],
  completed: ['Completed', '已完成'],
  'supply:in_stock': ['In stock', '有库存'],
  'supply:low_inventory': ['Low inventory', '库存不足'],
  'supply:vendor_transfer': ['Vendor transfer', '供应商调货'],
  'supply:production': ['Production', '生产中'],
  'supply:allocation': ['Allocation', '待分配'],
  'supply:no_stock': ['No stock', '无库存'],
  'supply:already_ordered': ['Already Ordered', '已订购']
});

/** @param {unknown} value */
export function parseSalesStockStatus(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !Object.hasOwn(SALES_STOCK_STATUSES, value)) {
    throw Object.assign(new Error('Select a supported Sales request status.'), {status: 400, code: 'SALES_STOCK_STATUS_INVALID'});
  }
  return value;
}

/** @param {Record<string,any>} request @param {number} now */
export function salesStockRequestStatus(request, now = Date.now()) {
  const regular = request.regular || {};
  const stocking = request.requestType === 'regular' && request.workflowVersion === 2 && regular.deliveryMethod === 'stocking';
  if (!stocking && !regular.handoffStatus && regular.approvalExpiresAt && now >= new Date(regular.approvalExpiresAt).getTime()) return 'expired';
  if (request.lines?.some((/** @type {{status?:string}} */ line) => line.status === 'changes_requested')) return 'changes_requested';
  return request.displayStatus || request.bucket || request.status;
}

/** @param {Record<string,any>} request @param {string} status */
export function matchesSalesStockStatus(request, status, now = Date.now()) {
  if (!status) return true;
  if (status.startsWith('supply:')) return (request.lines || []).some((/** @type {{supplyStatus?:string}} */ line) => line.supplyStatus === status.slice(7));
  return salesStockRequestStatus(request, now) === status;
}

/** @param {string} selected @param {string} language */
export function salesStockStatusOptions(selected, language = 'en') {
  const column = language === 'zh-CN' ? 1 : 0;
  const options = (/** @type {boolean} */ supply) => Object.entries(SALES_STOCK_STATUSES)
    .filter(([value]) => value.startsWith('supply:') === supply)
    .map(([value, labels]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${labels[column]}</option>`).join('');
  return `<option value="" ${selected === '' ? 'selected' : ''}>${column ? '所有状态' : 'All statuses'}</option>`
    + `<optgroup label="${column ? '申请状态' : 'Request status'}">${options(false)}</optgroup>`
    + `<optgroup label="${column ? '库存检查' : 'Stock check'}">${options(true)}</optgroup>`;
}
