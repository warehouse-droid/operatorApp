import {SPECIAL_STAGES} from './special-stock-workflow.js';
import {parseVendorNames} from './stock-request-vendor-filter.js';

export const SALES_REQUEST_TYPES = Object.freeze({
  stocking: ['Stocking', '备货'], backorder: ['Backorder', '欠货'],
  delivery: ['Delivery', '送货'], pickup: ['Pickup', '自取'],
  waitlist: ['Waitlist', '候补'], other: ['Other regular', '其他常规申请']
});
const stageChinese = ['新申请','待更新','待销售确认','已确认','安排发货','待生产 / 调货','已关闭','已完成'];
export const SALES_CASE_STAGES = Object.freeze(Object.fromEntries(Object.entries(SPECIAL_STAGES)
  .map(([value,label],index)=>[value,[value==='await_customer_confirmation'?'Await Sales confirmation':label,stageChinese[index]]])));

/** @param {unknown} value @param {Record<string,unknown>} options @param {string} field */
function parseChoices(value, options, field) {
  if (value == null || value === '') return [];
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
  if (values.length > 64 || values.some(choice => typeof choice !== 'string' || !Object.hasOwn(options, choice))) {
    throw Object.assign(new Error(`Select a supported ${field}.`), {status:400,code:'SALES_STOCK_FILTER_INVALID'});
  }
  return Object.keys(options).filter(choice => values.includes(choice));
}
/** @param {unknown} value */
export const parseSalesRequestTypes = value => parseChoices(value, SALES_REQUEST_TYPES, 'request type');
/** @param {unknown} value */
export const parseSalesCaseStages = value => parseChoices(value, SALES_CASE_STAGES, 'case stage');

/** @param {string|null} saved */
export function restoreSalesStockFilters(saved) {
  try {
    const value = JSON.parse(saved || '{}');
    return {requestTypeFilter:parseSalesRequestTypes(value.requestTypeFilter),
      backorderStageFilter:parseSalesCaseStages(value.backorderStageFilter), vendorFilter:parseVendorNames(value.vendorFilter)};
  } catch { return {requestTypeFilter:[],backorderStageFilter:[],vendorFilter:[]}; }
}

/** @param {unknown} value */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char] ?? char));

/** @param {{requestTypeFilter:string[],backorderStageFilter:string[],vendorFilter:string[],availableVendors?:string[],disabled?:boolean,language?:string}} state */
export function salesStockListFiltersHtml({requestTypeFilter,backorderStageFilter,vendorFilter,availableVendors=[],disabled=false,language='en'}) {
  const column = language === 'zh-CN' ? 1 : 0;
  const menu = (name, labels, options, selected) => {
    const label = labels[column], values = new Set(selected);
    return `<details name="sales-request-filter" class="stock-request-yard-filter sales-stock-filter" data-sales-multi-filter="${name}">
      <summary aria-label="${escapeHtml(label)}">${escapeHtml(label)}${values.size?` (${values.size})`:column?': 所有':': All'}</summary>
      <div role="group" aria-label="${escapeHtml(label)}">${Object.entries(options).map(([value,text])=>`<label><input type="checkbox" name="${name}" data-sales-stock-filter="${name}" value="${escapeHtml(value)}" ${values.has(value)?'checked':''} ${disabled?'disabled':''}> ${escapeHtml(text[column])}</label>`).join('')}
      <div class="stock-request-filter-actions"><button type="button" data-sales-filter-clear="${name}" ${disabled?'disabled':''}>${column?'清除选择':'Clear selection'}</button><button class="primary" type="button" data-sales-filter-apply="${name}" ${disabled?'disabled':''}>${column?'应用':'Apply'}</button></div></div></details>`;
  };
  const vendors = Object.fromEntries([...new Set([...availableVendors,...vendorFilter])].sort((a,b)=>a.localeCompare(b)).map(name=>[name,[name,name]]));
  return menu('backorderStageFilter',['Case stage','申请阶段'],SALES_CASE_STAGES,backorderStageFilter)
    + menu('requestTypeFilter',['Request type','申请类型'],SALES_REQUEST_TYPES,requestTypeFilter)
    + menu('vendorFilter',['Item vendor','商品供应商'],vendors,vendorFilter);
}
