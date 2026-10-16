// @ts-check
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { canonicalSha256 } from './mbt/canonical-json.js';
import { withCustomerTransaction } from './mbt/customer-database.js';
import { applyCanonicalCustomerAggregatesInTransaction } from './mbt/customer-sync-service.js';

/** @param {string} message @param {number} [status] */
function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** @param {unknown} value @param {string} field @returns {Record<string, unknown>} */
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${field} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} field @param {number} [maximum] @param {boolean} [required] */
function text(value, field, maximum = 500, required = false) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid(`${field} must be text of at most ${maximum} characters without control characters.`);
  }
  const result = value.trim();
  if (required && !result) { throw invalid(`${field} is required.`); }
  return result;
}

/** @param {unknown} value @param {string} field */
function internalId(value, field) {
  const result = typeof value === 'number' ? String(value) : value;
  if (typeof result !== 'string' || !/^[1-9]\d{0,15}$/u.test(result) || !Number.isSafeInteger(Number(result))) {
    throw invalid(`${field} must be a positive safe integer.`);
  }
  return result;
}

/** @param {unknown} value @param {string} field @param {boolean} [fallback] */
function boolean(value, field, fallback = undefined) {
  if (value === undefined && fallback !== undefined) { return fallback; }
  if (typeof value !== 'boolean') { throw invalid(`${field} must be a boolean.`); }
  return value;
}

/** @param {unknown} value @param {string} field @param {(row: Record<string, unknown>) => Record<string, unknown>} normalize */
function children(value, field, normalize) {
  if (!Array.isArray(value) || value.length > 100) { throw invalid(`${field} must be an array with at most 100 entries.`); }
  const result = value.map(entry => normalize(object(entry, field)));
  const ids = result.map(entry => entry.netsuiteAddressId || entry.netsuiteId);
  if (new Set(ids).size !== ids.length) { throw invalid(`${field} must have unique IDs.`); }
  return result.sort((left, right) => String(left.netsuiteAddressId || left.netsuiteId).localeCompare(String(right.netsuiteAddressId || right.netsuiteId)));
}

/** @param {Record<string, unknown>} row */
function address(row) {
  /** @type {Record<string, string | boolean>} */
  const result = { netsuiteAddressId: text(row.netsuiteAddressId, 'Address ID', 100, true) };
  for (const field of ['label', 'addressee', 'attention', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'region', 'postalCode', 'countryCode', 'phone']) {
    result[field] = text(row[field] ?? '', `Address ${field}`);
  }
  for (const field of ['billingDefault', 'shippingDefault', 'active']) {
    result[field] = boolean(row[field], `Address ${field}`, field === 'active');
  }
  return result;
}

/** @param {Record<string, unknown>} row */
function subsidiary(row) {
  return { netsuiteId: internalId(row.netsuiteId, 'Subsidiary ID'),
    relationshipName: text(row.relationshipName ?? '', 'Subsidiary name'),
    primary: boolean(row.primary, 'Primary subsidiary', false), active: boolean(row.active, 'Subsidiary active', true) };
}

/** @param {unknown} value */
function modifiedAt(value) {
  // Require the UTC representation emitted by SuiteScript's Date.toISOString().
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw invalid('Customer sourceModifiedAt must be a UTC ISO timestamp with milliseconds.');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value || date.getTime() > Date.now() + 300000) {
    throw invalid('Customer sourceModifiedAt must be a valid timestamp, no more than five minutes in the future.');
  }
  return value;
}

/** @param {unknown} payload @param {string} accountId */
export function normalizeCustomerWebhook(payload, accountId) {
  const envelope = object(payload, 'Webhook');
  if (envelope.schemaVersion !== 'netsuite-customer/v1' || envelope.recordType !== 'customer'
      || typeof envelope.eventType !== 'string' || !['create', 'edit', 'xedit'].includes(envelope.eventType)) {
    throw invalid('Expected a netsuite-customer/v1 customer create, edit or xedit event.');
  }
  const incomingAccount = text(envelope.accountId, 'Account ID', 100, true).toUpperCase().replaceAll('-', '_');
  const expectedAccount = String(accountId || '').trim().toUpperCase().replaceAll('-', '_');
  if (!expectedAccount || incomingAccount !== expectedAccount) { throw invalid('NetSuite account does not match this application.', 403); }
  const row = object(envelope.customer, 'Customer');
  const sourceModifiedAt = modifiedAt(row.sourceModifiedAt);
  const aggregate = {
    netsuiteId: internalId(row.netsuiteId, 'Customer NetSuite ID'),
    entityNumber: text(row.entityNumber, 'Customer entity number', 500, true),
    legalName: text(row.legalName, 'Customer legal name', 1000, true),
    displayName: text(row.displayName, 'Customer display name', 1000, true),
    currency: text(row.currency, 'Customer currency', 3, true).toUpperCase(),
    email: text(row.email, 'Customer email', 320), phone: text(row.phone, 'Customer phone', 100),
    active: boolean(row.active, 'Customer active'),
    terms: text(row.terms, 'Customer terms'), taxStatus: text(row.taxStatus, 'Customer tax status'),
    creditStatus: text(row.creditStatus, 'Customer credit status'),
    addresses: children(row.addresses, 'Customer addresses', address),
    subsidiaries: children(row.subsidiaries, 'Customer subsidiaries', subsidiary),
    contacts: [], sourceKind: 'customer_master_event', sourceAccountId: expectedAccount,
    sourceModifiedAt, sourceVersion: `netsuite-customer:${sourceModifiedAt}`
  };
  if (!/^[A-Z]{3}$/u.test(aggregate.currency)) { throw invalid('Customer currency must be an ISO currency code.'); }
  return { ...aggregate, payloadHash: canonicalSha256(aggregate) };
}

/** @param {unknown} payload @param {{accountId: string, database?: unknown}} options */
export async function acceptCustomerWebhook(payload, { accountId, database = pool }) {
  const aggregate = normalizeCustomerWebhook(payload, accountId);
  return withCustomerTransaction(database, async client => {
    const runId = randomUUID();
    await client.query(`INSERT INTO netsuite_customer_sync_runs (
      run_id, sync_kind, status, account_id, requested_by, correlation_id,
      pages_expected, pages_applied, records_seen, started_at, completed_at, metadata
    ) VALUES ($1::uuid, 'incremental', 'completed', $2, 'netsuite-customer-webhook', $4,
      1, 1, 1, now(), now(), $3::jsonb)`,
    [runId, aggregate.sourceAccountId, JSON.stringify({ source: 'netsuite-customer-webhook', customerId: aggregate.netsuiteId }), runId]);
    const result = await applyCanonicalCustomerAggregatesInTransaction(client, {
      aggregates: [aggregate], sourceKind: aggregate.sourceKind, accountId: aggregate.sourceAccountId
    }, { runId, publishEvents: true });
    const action = result.outcomes[0].action;
    await client.query(`UPDATE netsuite_customer_sync_runs SET records_applied=$2,
      records_conflicted=$3, metadata=metadata || $4::jsonb WHERE run_id=$1`,
    [runId, result.created + result.updated, result.conflicted, JSON.stringify({ action })]);
    await client.query(`INSERT INTO delivery_audit_log (actor_type, source, action, details)
      VALUES ('system', 'netsuite-webhook', 'netsuite.webhook.customer', $1::jsonb)`,
    [JSON.stringify({ customerId: aggregate.netsuiteId, action, runId })]);
    return { ok: action !== 'conflicted', customerId: aggregate.netsuiteId, action, duplicate: action === 'unchanged' };
  });
}
