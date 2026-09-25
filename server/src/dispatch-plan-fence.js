import { digestDispatchPlan } from './dispatch-planner-performance.js';

// This shape describes storage, before any live definition, CO, or SCM overlay.
// Never use the cached plan_digest column as evidence of unchanged storage.
export function persistedDispatchPlan(row) {
  if (!row) {return null;}
  const plan = {
    id: String(row.id ?? row.plan_id),
    planId: String(row.id ?? row.plan_id),
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date).slice(0, 10),
    status: row.status || 'draft', note: row.note || '', revision: Number(row.revision || 0),
    savedAt: row.saved_at || row.updated_at || null,
    orders: row.orders || [], trucks: row.trucks || [], summary: row.summary || {}
  };
  return { ...plan, digest: digestDispatchPlan(plan) };
}
