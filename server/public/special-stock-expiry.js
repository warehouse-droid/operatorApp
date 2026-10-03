import { torontoDate } from './special-stock-workflow.js';
const invalid = () => Object.assign(new Error('Choose a valid expiry date, today or later.'), { status: 400, code: 'SPECIAL_EXPIRY_INVALID' });
/** @param {unknown} value */
function calendarDate(value) {
  const text = String(value ?? '');
  const date = new Date(`${text}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== text) throw invalid();
  return date;
}
/** @param {string} [today] */
export function defaultSpecialExpiry(today = torontoDate()) {
  const date = calendarDate(today), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(day,lastDay));
  return date.toISOString().slice(0,10);
}
/** @param {unknown} value @param {string} [today] */
export function normalizeSpecialExpiry(value, today = torontoDate()) {
  calendarDate(today);
  const date = value == null || value === '' ? defaultSpecialExpiry(today) : String(value);
  calendarDate(date);
  if (date < today) throw invalid();
  return date;
}
