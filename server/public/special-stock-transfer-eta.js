import { isSpecialWorkingDay } from './special-stock-calendar.js';

export const SPECIAL_TRANSFER_ETA_MODE = 'so_placement';
export const SPECIAL_TRANSFER_ETA_LABEL = 'SO placement +5 working days';

/** @param {{supplyStatus?:string|null,availabilityMode?:string|null}} line */
export function isSpecialTransferEta(line) {
  return line.supplyStatus === 'vendor_transfer' && line.availabilityMode === SPECIAL_TRANSFER_ETA_MODE;
}

/** @param {{supplyStatus?:string|null,availabilityMode?:string|null,availableDate?:string|null}} line */
export function specialSupplyEtaLabel(line, fallback = '—') {
  return line.availableDate || (isSpecialTransferEta(line) ? SPECIAL_TRANSFER_ETA_LABEL : fallback);
}

/** Count from the day after placement using the shared Ontario working-day calendar.
 * @param {string|null|undefined} placementDate */
export function specialTransferAvailableDate(placementDate) {
  if (!placementDate) return null;
  const date = new Date(`${placementDate}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(placementDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== placementDate) {
    throw new Error('A valid SO placement date is required.');
  }
  let remaining = 5;
  while (remaining) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isSpecialWorkingDay(date)) remaining--;
  }
  return date.toISOString().slice(0, 10);
}
