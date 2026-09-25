// @ts-check
/** @typedef {{id?: string, role?: string, roles?: string[], yardLocationIds?: number[], operatorYardLocationIds?: number[], aggregateRequestYardLocationIds?: number[], publicSales?: boolean}} AggregateActor */
/** @typedef {{materialCode: string, requestedLoads: number, confirmedLoads: number|null, actualLoads: number|null, scmMemo?: string}} AggregateLine */
/** @typedef {{id: number, yardLocationId: number, requestedBy: string, serviceDate: string, reportDueDate: string, revision: number, status: string, remarks: string, needsReview: boolean, lines: AggregateLine[], confirmedBy?: string|null, confirmedAt?: string|null, reportedBy?: string|null, reportedAt?: string|null, acknowledgedBy?: string|null, acknowledgedAt?: string|null, decisionReason?: string, updatedAt?: string}} AggregateRequest */
/** @typedef {{expectedRevision?: number, loads?: Record<string, number>, memos?: Record<string, string>, remarks?: string, reason?: string, serviceDate?: string}} AggregateCommand */

export const AGGREGATE_MATERIALS = Object.freeze([
  { code: 'gravel', label: 'Gravel', direction: 'inbound' },
  { code: 'hpb', label: 'HPB', direction: 'inbound' },
  { code: 'screening', label: 'Screening', direction: 'inbound' },
  { code: 'crusher_run', label: 'Crusher Run', direction: 'inbound' },
  { code: 'dump_concrete', label: 'Dump Concrete', direction: 'outbound' },
  { code: 'dump_asphalt', label: 'Dump Asphalt', direction: 'outbound' },
  { code: 'dump_soil', label: 'Dump Soil', direction: 'outbound' }
].map(material => Object.freeze(material)));
export const AGGREGATE_YARDS = Object.freeze([
  { locationId: 1, yardCode: '3445' }, { locationId: 28, yardCode: '2967' },
  { locationId: 15, yardCode: '12441' }, { locationId: 26, yardCode: '150' }
].map(yard => Object.freeze(yard)));

/** @param {string} message @param {number} [status] @param {string} [code] */
export function aggregateError(message, status = 400, code = 'AGGREGATE_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

/** @param {Date} [now] */
export function aggregateDates(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const midnight = new Date(`${today}T00:00:00Z`);
  const plusDays = (/** @type {number} */ days) => new Date(midnight.getTime() + days * 86400000).toISOString().slice(0, 10);
  return { today, serviceDate: plusDays(1), reportDueDate: plusDays(2) };
}

/** @param {AggregateActor} actor */
function rolesFor(actor) {
  if (!actor?.id || actor.publicSales) { return new Set(); }
  return new Set([...(actor.roles || []), actor.role].filter(Boolean));
}

/** @param {AggregateActor} actor */
export function aggregateCanManage(actor) {
  const roles = rolesFor(actor);
  return ['admin', 'scm', 'scm_staff'].some(role => roles.has(role));
}

/** @param {AggregateActor} actor */
export function aggregateYardsForActor(actor) {
  if (aggregateCanManage(actor)) { return AGGREGATE_YARDS.map(yard => yard.locationId); }
  return aggregateSubmissionYards(actor);
}

/** @param {AggregateActor} actor */
export function canBeAggregateRequester(actor) {
  const roles = rolesFor(actor);
  return ['sales', 'operator', 'yard_manager'].some(role => roles.has(role));
}

/** @param {AggregateActor} actor */
export function aggregateSubmissionYards(actor) {
  if (!canBeAggregateRequester(actor)) { return []; }
  const yards = new Set(actor.aggregateRequestYardLocationIds || []);
  return AGGREGATE_YARDS.map(yard => yard.locationId).filter(id => yards.has(id));
}

/** @param {AggregateActor} actor @param {unknown} value */
export function assertAggregateYard(actor, value) {
  if (!Number.isInteger(value) || !AGGREGATE_YARDS.some(yard => yard.locationId === value)) {
    throw aggregateError('Select a valid yard.');
  }
  if (!aggregateYardsForActor(actor).includes(/** @type {number} */ (value))) {
    throw aggregateError('This yard is outside your assigned yards.', 403, 'AGGREGATE_YARD_FORBIDDEN');
  }
  return /** @type {number} */ (value);
}

/** @param {AggregateActor} actor */
export function assertAggregateSubmitter(actor) {
  if (!aggregateSubmissionYards(actor).length) {
    throw aggregateError('Aggregate request access is required. Ask Admin to assign a yard.', 403, 'AGGREGATE_ROLE_FORBIDDEN');
  }
}

/** @param {unknown} value @param {{positive?: boolean}} [options] @returns {Record<string, number>} */
export function normalizeAggregateLoads(value, { positive = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw aggregateError('Enter loads for every material.'); }
  const entries = Object.entries(value);
  const codes = new Set(AGGREGATE_MATERIALS.map(material => material.code));
  if (entries.length !== codes.size || entries.some(([code]) => !codes.has(code))) {
    throw aggregateError('Enter loads for all seven materials.');
  }
  const loads = Object.fromEntries(entries);
  for (const material of AGGREGATE_MATERIALS) {
    assertLoadAmount(loads[material.code], material.label);
  }
  if (positive && !Object.values(loads).some(amount => amount > 0)) {
    throw aggregateError('Request at least one load.');
  }
  return loads;
}

/** @param {unknown} amount @param {string} label */
function assertLoadAmount(amount, label) {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 1_000_000_000) {
    throw aggregateError(`${label}: enter a whole number of loads from 0 to 1,000,000,000.`);
  }
}

/** @param {unknown} value @param {boolean} [required] */
export function aggregateText(value, required = false) {
  if (value !== undefined && typeof value !== 'string') { throw aggregateError('Enter text for the remark or reason.'); }
  const text = String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if ((required && !text) || text.length > 2000) { throw aggregateError('Enter a reason of 1–2,000 characters.'); }
  return text;
}

/** @param {AggregateRequest} row @param {string[]} statuses */
function requireStatus(row, statuses) {
  if (!statuses.includes(row.status)) { throw aggregateError('This action is no longer available. Refresh the request.', 409, 'AGGREGATE_STATE_CONFLICT'); }
}

/** @param {AggregateRequest} row @param {AggregateActor} actor @param {boolean} [allowManager] */
function requireOwner(row, actor, allowManager = false) {
  if (allowManager && aggregateCanManage(actor)) { return; }
  if (row.requestedBy !== actor.id) { throw aggregateError('Only the original requester can perform this action.', 403, 'AGGREGATE_OWNER_REQUIRED'); }
}

/** @param {AggregateActor} actor */
function requireManager(actor) {
  if (!aggregateCanManage(actor)) { throw aggregateError('SCM edit access required.', 403, 'AGGREGATE_SCM_REQUIRED'); }
}

/** @param {AggregateRequest} row @param {Record<string, number>} loads @param {'requestedLoads'|'confirmedLoads'|'actualLoads'} field */
function setLoads(row, loads, field) {
  row.lines = row.lines.map(line => ({ ...line, [field]: loads[line.materialCode] }));
}

/** @param {AggregateRequest} row @param {AggregateCommand} input @param {AggregateActor} actor */
function edit(row, input, actor) {
  requireOwner(row, actor);
  requireStatus(row, ['submitted']);
  setLoads(row, normalizeAggregateLoads(input.loads, { positive: true }), 'requestedLoads');
  row.remarks = aggregateText(input.remarks);
}

/** @param {AggregateRequest} row @param {AggregateCommand} input @param {AggregateActor} actor @param {Date} now */
function confirm(row, input, actor, now) {
  requireManager(actor);
  requireStatus(row, ['submitted', 'confirmed']);
  if (input.serviceDate !== undefined) {
    const serviceDate = input.serviceDate;
    if (typeof serviceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)
      || serviceDate < '0001-01-01' || serviceDate > '9999-12-30') {
      throw aggregateError('Select a valid Delivery / collection date.');
    }
    const date = new Date(`${serviceDate}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== serviceDate) {
      throw aggregateError('Select a valid Delivery / collection date.');
    }
    row.serviceDate = serviceDate;
    date.setUTCDate(date.getUTCDate() + 1);
    row.reportDueDate = date.toISOString().slice(0, 10);
  }
  setLoads(row, normalizeAggregateLoads(input.loads), 'confirmedLoads');
  row.status = 'confirmed';
  row.confirmedBy = actor.id;
  row.confirmedAt = now.toISOString();
}

/** @param {AggregateRequest} row @param {AggregateCommand} input @param {AggregateActor} actor */
function reject(row, input, actor) {
  requireManager(actor);
  requireStatus(row, ['submitted']);
  row.decisionReason = aggregateText(input.reason, true);
  row.status = 'rejected';
}

/** @param {AggregateRequest} row @param {AggregateCommand} input */
function actuals(row, input) {
  setLoads(row, normalizeAggregateLoads(input.loads), 'actualLoads');
  row.needsReview = row.lines.some(line => line.actualLoads !== line.confirmedLoads);
  row.acknowledgedBy = null;
  row.acknowledgedAt = null;
}

/** @param {AggregateRequest} row @param {AggregateCommand} input @param {AggregateActor} actor @param {Date} now */
function report(row, input, actor, now) {
  requireOwner(row, actor, true);
  requireStatus(row, ['confirmed']);
  actuals(row, input);
  row.status = 'reported';
  row.reportedBy = actor.id;
  row.reportedAt = now.toISOString();
}

/** @param {AggregateRequest} row @param {AggregateCommand} input @param {AggregateActor} actor */
function correct(row, input, actor) {
  requireManager(actor);
  requireStatus(row, ['reported']);
  aggregateText(input.reason, true);
  actuals(row, input);
}

/** @param {AggregateRequest} row @param {AggregateCommand} _input @param {AggregateActor} actor @param {Date} now */
function acknowledge(row, _input, actor, now) {
  requireManager(actor);
  requireStatus(row, ['reported']);
  if (!row.needsReview) { throw aggregateError('This request does not need acknowledgment.', 409, 'AGGREGATE_STATE_CONFLICT'); }
  row.needsReview = false;
  row.acknowledgedBy = actor.id;
  row.acknowledgedAt = now.toISOString();
}

/** @param {AggregateRequest} row @param {AggregateCommand} input @param {AggregateActor} actor */
function memo(row, input, actor) {
  requireManager(actor);
  const entries = Object.entries(input.memos || {});
  const codes = new Set(AGGREGATE_MATERIALS.map(material => material.code));
  if (!input.memos || Array.isArray(input.memos) || entries.length !== codes.size
    || entries.some(([code, value]) => !codes.has(code) || typeof value !== 'string' || value.length > 2000)) {
    throw aggregateError('Enter a memo of up to 2,000 characters for every material.');
  }
  const memos = Object.fromEntries(entries.map(([code, value]) => [code, aggregateText(value)]));
  row.lines = row.lines.map(line => ({ ...line, scmMemo: memos[line.materialCode] }));
}

/** @type {Record<string, (row: AggregateRequest, input: AggregateCommand, actor: AggregateActor, now: Date) => void>} */
const actions = { edit, confirm, reject, report, correct, acknowledge, memo };

/** @param {AggregateRequest} request @param {string} action @param {AggregateCommand} input @param {AggregateActor} actor @param {Date} [now] */
export function transitionAggregateRequest(request, action, input, actor, now = new Date()) {
  assertAggregateYard(actor, request.yardLocationId);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== request.revision) {
    throw aggregateError('This request has changed. Refresh before saving.', 409, 'AGGREGATE_STALE_REVISION');
  }
  if (!Object.hasOwn(actions, action)) { throw aggregateError('Unknown aggregate request action.'); }
  const next = structuredClone(request);
  actions[action](next, input, actor, now);
  next.revision += 1;
  next.updatedAt = now.toISOString();
  return next;
}
