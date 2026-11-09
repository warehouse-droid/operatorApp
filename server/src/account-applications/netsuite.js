// NetSuite customer creation for approved account applications.
import { query } from '../db.js';
import { AccountApplicationError, PROVINCES } from '../../public/account-applications/domain.js';

const OPTIONS_TTL_MS = 10 * 60 * 1000;
const NATURE_LABELS = { renovation: 'Renovation', landscaping: 'Landscaping' };
const literal = (value, maximum = 200) => String(value ?? '').slice(0, maximum).replaceAll("'", "''");
const likeText = (value) => literal(String(value ?? '').toLowerCase().replace(/[%_]/gu, ' ').replace(/\s+/gu, ' ').trim(), 80);
const phoneDigits = (phone) => String(phone || '').split(' ext ')[0].replace(/\D/gu, '').slice(-10);
const idText = (value) => (/^\d{1,12}$/u.test(String(value ?? '')) ? String(value) : '');

export const externalIdFor = (number) => `ACCTAPP-${number}`;

export function entityIdFor(legalName, phone) {
  const digits = phoneDigits(phone);
  const suffix = digits.length === 10 ? ` / ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : '';
  return `${String(legalName).slice(0, 83 - suffix.length).trim()}${suffix}`;
}

export function customerComments(application, appBaseUrl) {
  const lines = [
    `Account application ${application.number} (${application.profile_snapshot?.label || application.company}).`,
    application.trade_name ? `Business trade name: ${application.trade_name}` : '',
    `Nature of business: ${(application.nature || []).map((value) => NATURE_LABELS[value] || value).join(', ')}`,
    `Signed by ${application.signer_name}, ${application.signer_title}.`,
    appBaseUrl ? `Application: ${new URL('/accounting/account-applications/' + application.id, appBaseUrl)}` : ''
  ];
  return lines.filter(Boolean).join('\n').slice(0, 3900);
}

export function buildCustomerPayload(application, approval, { appBaseUrl = '' } = {}) {
  const profile = application.profile_snapshot || {};
  const reference = (id) => (idText(id) ? { id: idText(id) } : undefined);
  const payload = {
    isPerson: false,
    companyName: application.legal_name,
    entityId: entityIdFor(application.legal_name, application.phone),
    subsidiary: reference(profile.netsuite?.subsidiaryId),
    entityStatus: reference(approval.statusId),
    terms: reference(approval.termsId),
    priceLevel: reference(approval.priceLevelId),
    salesRep: reference(approval.salesRepId),
    custentity_credit_level: reference(approval.creditLevelId),
    phone: application.phone,
    email: application.email,
    comments: customerComments(application, appBaseUrl),
    addressBook: { items: [{ defaultBilling: true, defaultShipping: true, label: 'Main',
      addressBookAddress: { addressee: application.legal_name, addr1: application.street, city: application.city,
        state: application.province, zip: application.postal_code, country: { id: 'CA' } } }] }
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== ''));
}

export function buildContactPayload(application, customerId) {
  const name = String(application.signer_name || '').trim();
  const space = name.lastIndexOf(' ');
  return {
    entityId: `${name} (${application.legal_name})`.slice(0, 83),
    firstName: (space > 0 ? name.slice(0, space) : name).slice(0, 32),
    ...(space > 0 ? { lastName: name.slice(space + 1).slice(0, 32) } : {}),
    title: String(application.signer_title || '').slice(0, 99),
    email: application.email,
    phone: application.phone,
    company: { id: String(customerId) },
    subsidiary: { id: idText(application.profile_snapshot?.netsuite?.subsidiaryId) }
  };
}

function distinctOptions(rows) {
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? row.id) }))
    .filter((row) => row.id && row.name).sort((a, b) => a.name.localeCompare(b.name));
}

export function createNetSuiteGateway({ suiteqlAll, upsert, appBaseUrl = '', now = () => Date.now(), logger = console }) {
  let cached = null;
  async function options() {
    if (cached && now() - cached.at < OPTIONS_TTL_MS) return cached.value;
    const run = async (sql) => { try { return await suiteqlAll(sql); } catch (error) { logger.warn?.('[Account applications] NetSuite option list failed.', { message: String(error?.message || '').slice(0, 200) }); return null; } };
    const [terms, creditLevels, priceLevels, statuses, salesReps] = await Promise.all([
      run('SELECT DISTINCT c.terms AS id, BUILTIN.DF(c.terms) AS name FROM customer c WHERE c.terms IS NOT NULL'),
      run('SELECT DISTINCT c.custentity_credit_level AS id, BUILTIN.DF(c.custentity_credit_level) AS name FROM customer c WHERE c.custentity_credit_level IS NOT NULL'),
      run('SELECT DISTINCT c.pricelevel AS id, BUILTIN.DF(c.pricelevel) AS name FROM customer c WHERE c.pricelevel IS NOT NULL'),
      run('SELECT DISTINCT c.entitystatus AS id, BUILTIN.DF(c.entitystatus) AS name FROM customer c WHERE c.entitystatus IS NOT NULL'),
      run("SELECT e.id AS id, e.entityid AS name FROM employee e WHERE e.issalesrep = 'T' AND e.isinactive = 'F'")
    ]);
    const value = {
      terms: terms ? distinctOptions(terms) : null,
      creditLevels: creditLevels ? distinctOptions(creditLevels).sort((a, b) => (a.name === 'None') - (b.name === 'None') || a.name.localeCompare(b.name)) : null,
      priceLevels: priceLevels ? distinctOptions(priceLevels) : null,
      statuses: statuses ? distinctOptions(statuses).filter((row) => /^customer/iu.test(row.name)) : null,
      salesReps: salesReps ? distinctOptions(salesReps) : null
    };
    if (Object.values(value).every(Boolean)) cached = { at: now(), value };
    return value;
  }

  async function findMatches(application) {
    const digits = phoneDigits(application.phone);
    const email = String(application.email || '').toLowerCase();
    const name = likeText(application.legal_name);
    const local = (await query(`SELECT netsuite_id::text AS id, entity_number AS "entityId", legal_name AS "companyName", phone, email, active
      FROM netsuite_customers
      WHERE ($1 <> '' AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10) = $1)
         OR ($2 <> '' AND lower(COALESCE(email,'')) = $2)
         OR ($3 <> '' AND lower(legal_name) LIKE '%'||$3||'%')
      ORDER BY active DESC, netsuite_id DESC LIMIT 10`, [digits.length === 10 ? digits : '', email, name.length >= 4 ? name : ''])).rows
      .map((row) => ({ ...row, source: 'mirror' }));
    let remote = [], remoteError = '';
    const clauses = [];
    if (digits.length === 10) {
      const pattern = `%${digits.slice(0, 3)}%${digits.slice(3, 6)}%${digits.slice(6)}%`;
      clauses.push(`c.phone LIKE '${pattern}'`, `c.entityid LIKE '${pattern}'`);
    }
    if (email) clauses.push(`LOWER(c.email) = '${literal(email, 254)}'`);
    if (name.length >= 4) clauses.push(`LOWER(c.companyname) LIKE '%${name}%'`);
    if (clauses.length) {
      try {
        remote = (await suiteqlAll(`SELECT c.id AS id, c.entityid AS entityid, c.companyname AS companyname, c.phone AS phone, c.email AS email,
          BUILTIN.DF(c.subsidiary) AS subsidiary, c.isinactive AS isinactive FROM customer c WHERE ${clauses.join(' OR ')} ORDER BY c.id DESC`))
          .slice(0, 15).map((row) => ({ id: String(row.id), entityId: row.entityid || '', companyName: row.companyname || '', phone: row.phone || '',
            email: row.email || '', subsidiary: row.subsidiary || '', active: row.isinactive !== 'T', source: 'netsuite' }));
      } catch (error) { remoteError = 'NetSuite search is unavailable; showing local matches only.'; logger.warn?.('[Account applications] NetSuite duplicate search failed.', { message: String(error?.message || '').slice(0, 200) }); }
    }
    const byId = new Map();
    for (const row of [...remote, ...local]) if (!byId.has(row.id)) byId.set(row.id, row);
    return { items: [...byId.values()], warning: remoteError };
  }

  async function customerByExternalId(externalId) {
    const rows = await suiteqlAll(`SELECT c.id AS id, c.entityid AS entityid FROM customer c WHERE c.externalid = '${literal(externalId, 100)}'`);
    return rows[0] ? { id: String(rows[0].id), entityId: rows[0].entityid || '' } : null;
  }

  async function createCustomer(application, approval) {
    const externalId = externalIdFor(application.number);
    const warnings = [];
    try {
      await upsert('customer', externalId, buildCustomerPayload(application, approval, { appBaseUrl }));
    } catch (error) {
      throw new AccountApplicationError(`NetSuite did not accept the customer: ${netSuiteMessage(error)}`, 502, 'ACCOUNT_APPLICATION_NETSUITE_FAILED');
    }
    const customer = await customerByExternalId(externalId);
    if (!customer) throw new AccountApplicationError('NetSuite saved the customer but its ID could not be read back. Retry to finish.', 502, 'ACCOUNT_APPLICATION_NETSUITE_READBACK');
    for (const subsidiaryId of (application.profile_snapshot?.netsuite?.additionalSubsidiaryIds || []).map(idText).filter(Boolean)) {
      try {
        await upsert('customerSubsidiaryRelationship', `${externalId}-SUB${subsidiaryId}`, { entity: { id: customer.id }, subsidiary: { id: subsidiaryId } });
      } catch (error) { warnings.push(`Subsidiary ${subsidiaryId} could not be added: ${netSuiteMessage(error)}`); }
    }
    try { await upsert('contact', `${externalId}-SIGNER`, buildContactPayload(application, customer.id)); }
    catch (error) { warnings.push(`Signer contact could not be created: ${netSuiteMessage(error)}`); }
    return { customerId: customer.id, entityId: customer.entityId, externalId, warnings };
  }

  async function customerById(id) {
    const value = idText(id);
    if (!value) throw new AccountApplicationError('Enter a NetSuite customer internal ID.');
    const rows = await suiteqlAll(`SELECT c.id AS id, c.entityid AS entityid, c.companyname AS companyname FROM customer c WHERE c.id = ${value}`);
    if (!rows[0]) throw new AccountApplicationError('No NetSuite customer has that internal ID.', 404, 'ACCOUNT_APPLICATION_CUSTOMER_NOT_FOUND');
    return { id: String(rows[0].id), entityId: rows[0].entityid || '', companyName: rows[0].companyname || '' };
  }

  return { options, findMatches, createCustomer, customerById };
}

function netSuiteMessage(error) {
  const detail = error?.netsuiteErrorDetails?.[0]?.detail;
  return String(detail || error?.message || 'unknown error').replace(/\s+/gu, ' ').slice(0, 300);
}

export const provinceName = (code) => PROVINCES.find(([value]) => value === code)?.[1] || code;
