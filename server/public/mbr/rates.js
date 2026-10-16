// @ts-check
import {MbrError,moneyMinor,requiredText} from './domain.js';
/** @typedef {{dailyRateMinor:number|null,weeklyRateMinor:number|null,monthlyRateMinor:number|null}} RentalRates */
/** @typedef {RentalRates & {model:string}} ModelRates */
/** @param {unknown} value */
function optionalRate(value) {
  return value===null || value===undefined || (typeof value==='string' && !value.trim())?null:moneyMinor(value);
}
/** @param {unknown} input @returns {ModelRates} */
export function normalizeModelRates(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) {throw new MbrError('Model rates are required.');}
  const data=/** @type {Record<string,unknown>} */ (input);
  return {model:requiredText(data.model,'Model'),dailyRateMinor:optionalRate(data.dailyRate),
    weeklyRateMinor:optionalRate(data.weeklyRate),monthlyRateMinor:optionalRate(data.monthlyRate)};
}
/** @param {ModelRates[]} items @param {string} model @returns {RentalRates} */
export function ratesForModel(items,model) {
  const row=items.find(item=>item.model===model);
  return {dailyRateMinor:row?.dailyRateMinor ?? null,weeklyRateMinor:row?.weeklyRateMinor ?? null,
    monthlyRateMinor:row?.monthlyRateMinor ?? null};
}
