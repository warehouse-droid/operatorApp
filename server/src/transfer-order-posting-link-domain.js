// @ts-check
/** @param {unknown} value */
export function transferPostingDate(value) {
  if (value instanceof Date) {return Number.isFinite(value.getTime()) ? value.toISOString().slice(0,10) : null;}
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value)) {return null;}
  const day=value.slice(0,10),date=new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===day ? day : null;
}
/** @param {unknown[]} values */
const unique=values=>[...new Set(values.map(value=>String(value ?? '').trim()).filter(Boolean))].sort();
/** @param {Record<string,any>} dependency */
function deliveryRefs(dependency) {
  const dispatchRef=String(dependency.dispatch_target_ref || dependency.sales_order_ref).trim();
  return /^SO/iu.test(dispatchRef) ? [dispatchRef] : unique([dependency.sales_order_ref,...(dependency.source_order_refs || [])]);
}
/** @param {Record<string,any>[]} dependencies */
export function linkedTransferDriverScope(dependencies) {
  const direct=dependencies.filter(d=>d.dependency_mode==='direct_to_customer' && d.status!=='cancelled');
  if (!direct.length) {return null;}
  const driverTarget={dependencyIds:unique(direct.map(d=>d.id)),orderRefs:unique(direct.flatMap(deliveryRefs)),
    dispatchRefs:unique(direct.map(d=>d.dispatch_target_ref || d.sales_order_ref))};
  const scopes=direct.map(d=>({planId:d.planned_plan_id ? String(d.planned_plan_id) : null,
    loadId:d.planned_load_id || null,planDate:transferPostingDate(d.planned_date)}));
  const invalid=direct.some(d=>!d.same_load_required || d.status==='attention' || d.plan_active===false)
    || scopes.some(s=>!s.planId || !s.loadId || !s.planDate)
    || new Set(scopes.map(s=>JSON.stringify(s))).size!==1 || !driverTarget.orderRefs.length;
  return {driverTarget,...scopes[0],linkError:invalid ? 'The linked SO dispatch assignment is incomplete or ambiguous. Review its plan, load and date.' : null};
}
