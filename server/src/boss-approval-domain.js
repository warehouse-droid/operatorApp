import { createHash } from 'node:crypto';

export const BOSS_IDENTITIES = Object.freeze(['tony_tan', 'jason_pu', 'alex_huang']);
export const APPROVED_SO_STATUSES = Object.freeze(['B', 'D', 'E', 'F', 'G']);
export const bossError = (message, status = 400, code = 'BOSS_INVALID') => Object.assign(new Error(message), { status, code });
export function hasBossRole(actor) {
  return actor?.active !== false && [...(actor?.roles || []), actor?.role].includes('boss');
}
export function eligibleBossIds(ownerId, roster) {
  const matching = roster.find(p => ownerId != null && String(p.ownerId) === String(ownerId));
  return (matching ? [matching] : roster).filter(p => p.operatorId && p.active && (p.roles || []).includes('boss')).map(p => p.operatorId);
}
export function requireBoss(actor, roster) {
  const person = roster.find(p => p.operatorId === actor?.id && p.active && (p.roles || []).includes('boss'));
  if (!hasBossRole(actor) || !person) { throw bossError('A configured BOSS account is required.', 403, 'BOSS_FORBIDDEN'); }
  return person;
}
export function positiveId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) { throw bossError('A valid positive ID is required.'); }
  return number;
}
export function amount(value) {
  if (value === null || value === undefined || value === '') { return null; }
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) { return null; }
  const [whole, fraction = ''] = text.split('.');
  const integral = whole.replace(/^(-?)0+(?=\d)/, '$1');
  const decimal = fraction.replace(/0+$/, '');
  const normalized = integral + (decimal ? '.' + decimal : '');
  return normalized === '-0' ? '0' : normalized;
}
function addAmounts(values) {
  if (values.some(value => value === null)) { return null; }
  const scale = Math.max(...values.map(value => (value.split('.')[1] || '').length));
  const total = values.reduce((sum, value) => {
    const fraction = (value.split('.')[1] || '').length;
    return sum + BigInt(value.replace('.', '')) * 10n ** BigInt(scale - fraction);
  }, 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
  return amount(`${total < 0n ? '-' : ''}${scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits}`);
}
function creditFigures(creditLimit, balance, unbilledOrders) {
  const used = addAmounts([balance, unbilledOrders]);
  const currentOwed = used === null || used === '0' ? used : used.startsWith('-') ? used.slice(1) : '-' + used;
  return { currentOwed, creditBalance: addAmounts([creditLimit, currentOwed]) };
}
export function normalizeSnapshot(input) {
  const creditLimit = amount(input.creditLimit), balance = amount(input.balance), unbilledOrders = amount(input.unbilledOrders);
  return {
    orderId: positiveId(input.orderId), tranid: String(input.tranid || ''),
    status: String(input.status || '').toUpperCase(), customerId: positiveId(input.customerId),
    customerName: String(input.customerName || ''), ownerId: input.ownerId == null || input.ownerId === '' ? null : String(input.ownerId),
    ownerName: String(input.ownerName || ''), creditLimit, balance, unbilledOrders,
    ...creditFigures(creditLimit, balance, unbilledOrders),
    currency: String(input.currency || ''), orderVersion: String(input.orderVersion || ''),
    orderTotal: amount(input.orderTotal), approvalState: String(input.approvalState || ''),
    refreshedAt: input.refreshedAt || new Date().toISOString()
  };
}
export function snapshotFingerprint(snapshot) {
  const { refreshedAt: _time, ...stable } = normalizeSnapshot(snapshot);
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
export function snapshotReady(snapshot) {
  return snapshot.status === 'A' && snapshot.creditLimit !== null && snapshot.balance !== null
    && amount(snapshot.unbilledOrders) !== null && Boolean(snapshot.currency && snapshot.orderVersion);
}
export function validDecision(input) {
  if (!['accept', 'reject'].includes(input.action)) { throw bossError('Choose Accept or Reject.'); }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input.commandId))) { throw bossError('A valid decision ID is required.'); }
  return { requestId: positiveId(input.requestId), expectedRevision: positiveId(input.expectedRevision), commandId: input.commandId, action: input.action };
}
