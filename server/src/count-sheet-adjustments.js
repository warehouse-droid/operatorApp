// @ts-check
import {inventoryError, inventoryId} from './inventory-workflow-domain.js';

/** @param {unknown} input */
export function countSheetAdjustments(input) {
  if (!Array.isArray(input) || !input.length || input.length > 1000) {
    throw inventoryError('Choose between 1 and 1000 counted rows to adjust.');
  }
  const seen = new Set();
  return input.map(row => {
    const itemId = inventoryId(row?.itemId, 'SKU');
    const value = row?.adjusting;
    if (seen.has(itemId)) {throw inventoryError('Each SKU can be adjusted only once.');}
    seen.add(itemId);
    if (!['string', 'number'].includes(typeof value) ||
        !/^[+-]?(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(String(value).trim()) ||
        !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e12) {
      throw inventoryError('Adjusting must be a number between −1,000,000,000,000 and 1,000,000,000,000 with at most six decimal places.');
    }
    return {itemId, adjusting:Number(value)};
  });
}
