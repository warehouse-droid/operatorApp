import { isSpecialWorkingDay } from './special-stock-calendar.js';
/** @param {string} message @param {string} code */
function invalid(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

/** @param {unknown} value @param {number} maximum @param {number} decimals @param {string} label @param {string} code */
function decimal(value, maximum, decimals, label, code) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw invalid(`${label} is required.`, code);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum || number !== Number(number.toFixed(decimals))) {
    throw invalid(`${label} must be between 0 and ${maximum}, with at most ${decimals} decimal places.`, code);
  }
  return number;
}

/** @param {unknown} value */
export function normalizeSpecialRate(value) {
  return decimal(value, 1e9, 6, 'Original unit rate', 'SPECIAL_RATE_INVALID');
}

/** @param {unknown} value */
export function normalizeSpecialDiscount(value) {
  return decimal(value == null || value === '' ? 0 : value, 100, 4, 'Discount percentage', 'SPECIAL_DISCOUNT_INVALID');
}

/** @param {unknown} rate @param {unknown} discount */
export function discountedSpecialRate(rate, discount) {
  const base = BigInt(normalizeSpecialRate(rate).toFixed(6).replace('.', ''));
  const percent = BigInt(normalizeSpecialDiscount(discount).toFixed(4).replace('.', ''));
  // Round once, half up, at NetSuite's six-place unit-rate precision.
  return Number((base * (1_000_000n - percent) + 500_000n) / 1_000_000n) / 1e6;
}

/** @param {Date} [now] */
export function earliestSpecialDeliveryDate(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw invalid('The creation date is invalid.', 'SPECIAL_DELIVERY_DATE_INVALID');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const cursor = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  for (let added = 0; added < 3;) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isSpecialWorkingDay(cursor)) added++;
  }
  return cursor.toISOString().slice(0, 10);
}

/** @param {unknown} value @param {{now?:Date}} [options] */
export function assertSpecialDeliveryDate(value, { now = new Date() } = {}) {
  const date = String(value ?? '').trim();
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) {
    throw invalid('Preferred delivery date is invalid.', 'SPECIAL_DELIVERY_DATE_INVALID');
  }
  const minimum = earliestSpecialDeliveryDate(now);
  if (date < minimum) throw invalid(`Preferred delivery date must be ${minimum} or later (three working days from SO creation, excluding Ontario public holidays).`, 'SPECIAL_DELIVERY_DATE_TOO_SOON');
  return date;
}

/** @param {number} number */
const micros = number => BigInt(number.toFixed(6).replace('.', ''));
/** @param {unknown} value @param {string} [code] */
export function specialQuantity(value, code = 'SPECIAL_QUANTITY_INVALID') {
  const number = decimal(value, 1e9, 6, 'Quantity', code);
  if (number <= 0) throw invalid('Quantity must be greater than zero.', code);
  return number;
}

/** @param {unknown} quantity @param {unknown} rate @param {unknown} discount */
export function specialLineSubtotal(quantity, rate, discount = 0) {
  // Enquiry quantities predate native SO precision limits. Compute the exact
  // decimal subtotal without rounding their original input to six places.
  const value = Number(quantity);
  if (!['number','string'].includes(typeof quantity) || !Number.isFinite(value) || value <= 0 || value > 1e9) throw invalid('A positive bounded quantity is required.', 'SPECIAL_QUANTITY_INVALID');
  const [coefficient, exponent = '0'] = value.toString().split('e');
  const scale = (coefficient.split('.')[1]?.length || 0) - Number(exponent);
  const units = BigInt(coefficient.replace('.', '')), price = micros(normalizeSpecialRate(rate));
  const percent = BigInt(normalizeSpecialDiscount(discount).toFixed(4).replace('.', ''));
  const denominator = 10n ** BigInt(scale + 10);
  const cents = (units * price * (1_000_000n - percent) + denominator / 2n) / denominator;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('The line subtotal is too large.', 'SPECIAL_SUBTOTAL_INVALID');
  return Number(cents) / 100;
}

/** @param {{quantity:unknown,rate:unknown,discountPercent?:unknown,conversionToPc:unknown}} input */
export function specialNativePricing({ quantity, rate, discountPercent = 0, conversionToPc }) {
  const packageQuantity = specialQuantity(quantity);
  const conversion = specialQuantity(conversionToPc, 'SPECIAL_CONVERSION_INVALID');
  const product = micros(packageQuantity) * micros(conversion);
  if (product % 1_000_000n !== 0n || product / 1_000_000n > 1_000_000_000_000_000n) {
    throw invalid('Converted PC quantity is too large or needs more than six decimal places.', 'SPECIAL_CONVERSION_INVALID');
  }
  const nativeQuantity = Number(product / 1_000_000n) / 1e6;
  const percent = BigInt(normalizeSpecialDiscount(discountPercent).toFixed(4).replace('.', ''));
  const divisor = micros(conversion);
  const nativeRate = Number((micros(normalizeSpecialRate(rate)) * (1_000_000n - percent) + divisor / 2n) / divisor) / 1e6;
  const subtotal = specialLineSubtotal(packageQuantity, rate, discountPercent);
  if (specialLineSubtotal(nativeQuantity, nativeRate, 0) !== subtotal) {
    throw invalid('This PC conversion cannot preserve the quoted subtotal at the supported rate precision.', 'SPECIAL_CONVERSION_ROUNDING');
  }
  return { packageQuantity, conversionToPc: conversion, quantity: nativeQuantity, uom: 'PC', rate: nativeRate, subtotal };
}
