import { createHash } from 'node:crypto';
import { normalizeAccountEmail } from './account-email.js';

/** @param {unknown} value */
export function normalizeReturnRecipient(value) {
  const invalid = () => Object.assign(new Error('Enter one email address or mobile number (include +country code outside Canada/US).'), { status: 400 });
  if (typeof value !== 'string' || value.length > 254 || /[\x00-\x1f\x7f]/.test(value)) { throw invalid(); }
  const input = value.trim();
  if (input.includes('@')) { return { channel: 'email', recipient: normalizeAccountEmail(input) }; }
  if (!/^\+?[0-9() .-]+$/.test(input)) { throw invalid(); }
  let phone = input.replace(/[() .-]/g, '');
  if (/^[2-9]\d{9}$/.test(phone)) { phone = `+1${phone}`; }
  else if (/^1[2-9]\d{9}$/.test(phone)) { phone = `+${phone}`; }
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) { throw invalid(); }
  return { channel: 'sms', recipient: phone };
}

/** @param {any} record */
function postedReference(record) {
  const reference = String(record.netSuiteTransactionRef || '').trim();
  if (record.status === 'voided' || record.voidedAt
    || !['succeeded', 'manual_linked'].includes(record.netSuiteSyncStatus)
    || !['credit_memo', 'return_authorization'].includes(record.netSuiteStage)
    || !(Number(record.netSuiteTransactionId) > 0)
    || !reference || reference.length > 100 || /[\x00-\x1f\x7f]/.test(reference)) {
    throw Object.assign(new Error('Send is available after this return is posted to NetSuite with a Credit Memo / RA number.'), { status: 409 });
  }
  return { type: record.netSuiteStage, id: Number(record.netSuiteTransactionId), reference };
}

/** @param {any[]} records */
export function buildReturnNotification(records) {
  if (!records.length) { throw Object.assign(new Error('No posted return was found.'), { status: 409 }); }
  const transactions = [...new Map(records.map(postedReference).map(value => [`${value.type}:${value.id}`, value])).values()]
    .sort((a, b) => a.id - b.id || a.type.localeCompare(b.type));
  const types = new Set(records.map(record => record.recordType));
  const kind = types.size > 1 ? 'stock and pallet' : types.has('pallet') ? 'pallet' : 'stock';
  const references = transactions.map(value => `${value.type === 'credit_memo' ? 'Credit Memo' : 'Return Authorization'}: ${value.reference}`).join('; ');
  return {
    subject: `MBBS return confirmation - ${transactions.map(value => value.reference).join(', ')}`,
    text: `MBBS: Your ${kind} return has been posted to NetSuite. ${references}. Thank you.`,
    referenceKey: createHash('sha256').update(JSON.stringify(transactions)).digest('hex')
  };
}
