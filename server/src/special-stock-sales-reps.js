import { suiteqlAll } from './netsuite.js';
import { query } from './db.js';
/** @typedef {{id:number,name:string}} SalesRep */
/** @param {{queryAll?:(sql:string)=>Promise<{id:string|number,name:string}[]>,loadCache?:()=>Promise<SalesRep[]|null>,saveCache?:(reps:SalesRep[])=>Promise<void>}} [dependencies] */
export function createSpecialSalesRepDirectory({queryAll=suiteqlAll,loadCache=async()=>null,saveCache=async()=>{}} = {}) {
  /** @type {SalesRep[]|null} */
  let cached = null;
  async function list() {
    const rows = await queryAll("SELECT id, entityid AS name FROM employee WHERE issalesrep='T' AND isinactive='F' ORDER BY entityid, id");
    const reps = rows.map(row=>({id:Number(row.id),name:String(row.name || '').trim()}))
      .filter(row=>Number.isSafeInteger(row.id) && row.id>0 && row.name);
    await saveCache(reps);
    cached = reps;
    return reps;
  }
  /** @param {unknown} value @param {{localOnly?:boolean}} [options] */
  async function select(value, {localOnly=false} = {}) {
    const id = Number(value);
    const reps = !Number.isSafeInteger(id) || id <= 0 ? [] : localOnly ? cached ?? await loadCache() ?? [] : await list();
    const match = reps.find(rep=>rep.id===id);
    if (!match) throw Object.assign(Error('Select an active NetSuite Sales Rep.'), {status:400,code:'SPECIAL_SALES_REP_REQUIRED'});
    return match;
  }
  return {list,select};
}
export const specialSalesRepCache = {
  loadCache: async () => (await query('SELECT reps FROM special_stock_sales_rep_cache WHERE singleton')).rows[0]?.reps ?? null,
  /** @param {SalesRep[]} reps */
  saveCache: async reps => { await query(`INSERT INTO special_stock_sales_rep_cache(singleton,reps) VALUES(true,$1::jsonb)
    ON CONFLICT(singleton) DO UPDATE SET reps=EXCLUDED.reps,refreshed_at=now()`, [JSON.stringify(reps)]); }
};
export const specialSalesReps = createSpecialSalesRepDirectory(specialSalesRepCache);
