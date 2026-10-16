import {AsyncLocalStorage} from 'node:async_hooks';

// Each transaction/HTTP action keeps its own profile. The default deliberately
// limits existing Special routes and background order jobs to Special cases.
/** @type {AsyncLocalStorage<"backorder">} */
const workflow = new AsyncLocalStorage();
export const stockCaseWorkflow = () => workflow.getStore() || 'special';
/** @template T @param {()=>T} run @returns {T} */
export function withBackorderWorkflow(run) {
  return workflow.run('backorder', run);
}
