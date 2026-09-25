export const mutants = {
  'ignore-edit-lease': ['src/dispatch-plan-maintenance-queue.js', 'return lease.rows.length > 0;', 'return false;'],
  'acknowledge-newer-work': ['src/dispatch-plan-maintenance-queue.js',
    'DELETE FROM dispatch_plan_maintenance WHERE plan_id=$1 AND generation=$2',
    'DELETE FROM dispatch_plan_maintenance WHERE plan_id=$1 AND $2::bigint>0'],
  'never-complete-work': ['src/dispatch-plan-maintenance-queue.js',
    'DELETE FROM dispatch_plan_maintenance WHERE plan_id=$1 AND generation=$2',
    'DELETE FROM dispatch_plan_maintenance WHERE plan_id=$1 AND generation=$2 AND false'],
  'reverse-rename-order': ['src/dispatch-plan-maintenance.js',
    'Number(a.sequence || 0) - Number(b.sequence || 0)', 'Number(b.sequence || 0) - Number(a.sequence || 0)'],
  'skip-sales-cleanup': ['src/dispatch-plan-maintenance.js',
    'return applyDispatchSalesFamilyMaintenance(plan, request);', 'return { plan };'],
  'ignore-driver-protection': ['src/dispatch-plan-maintenance.js',
    'proposal.deferred || !policy.allowed', 'proposal.deferred'],
  'forget-buffered-corrections': ['src/dispatch-plan-maintenance.js',
    "editing && ['po_reference', 'retire_splits'].includes(request.kind)", 'false']
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = mutants[process.env.ORDER_UPDATE_SAVE_MUTANT];
  if (!mutation || !url.endsWith(`/${mutation[0]}`)) return result;
  const source = String(result.source);
  if (source.split(mutation[1]).length !== 2) throw new Error(`Invalid mutation anchor: ${process.env.ORDER_UPDATE_SAVE_MUTANT}`);
  return { ...result, source: source.replace(mutation[1], mutation[2]) };
}
