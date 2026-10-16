import {query} from '../db.js';
import {MbrError} from '../../public/mbr/domain.js';
import {normalizeModelRates} from '../../public/mbr/rates.js';

const columns=`model,daily_rate_minor::double precision AS "dailyRateMinor",
  weekly_rate_minor::double precision AS "weeklyRateMinor",monthly_rate_minor::double precision AS "monthlyRateMinor",revision`;
export function createMbrRatesRepository() {
  async function list() {
    return {items:(await query(`SELECT e.model,r.daily_rate_minor::double precision AS "dailyRateMinor",
      r.weekly_rate_minor::double precision AS "weeklyRateMinor",r.monthly_rate_minor::double precision AS "monthlyRateMinor",
      COALESCE(r.revision,0) AS revision FROM (SELECT DISTINCT model FROM mbr_equipment) e
      LEFT JOIN mbr_model_rates r ON r.model=e.model ORDER BY e.model`)).rows};
  }
  async function edit(actor,input) {
    const rates=normalizeModelRates(input),revision=input.revision;
    if(!Number.isSafeInteger(revision) || revision<0 || revision>2147483647) {throw new MbrError('A valid model rate revision is required.');}
    if(!(await query('SELECT 1 FROM mbr_equipment WHERE model=$1 LIMIT 1',[rates.model])).rows[0]) {
      throw new MbrError('Equipment model not found in MBR Setup.',404,'MBR_MODEL_NOT_FOUND');
    }
    const values=[rates.model,rates.dailyRateMinor,rates.weeklyRateMinor,rates.monthlyRateMinor,actor.id];
    const result=revision===0
      ?await query(`INSERT INTO mbr_model_rates(model,daily_rate_minor,weekly_rate_minor,monthly_rate_minor,updated_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(model) DO NOTHING RETURNING ${columns}`,values)
      :await query(`UPDATE mbr_model_rates SET daily_rate_minor=$2,weekly_rate_minor=$3,monthly_rate_minor=$4,
        updated_by=$5,updated_at=clock_timestamp(),revision=revision+1 WHERE model=$1 AND revision=$6 RETURNING ${columns}`,[...values,revision]);
    if(result.rows[0]) {return result.rows[0];}
    throw new MbrError('These model rates changed. Reload MBR Setup before editing them again.',409,'MBR_RATES_CHANGED');
  }
  return {list,edit};
}
