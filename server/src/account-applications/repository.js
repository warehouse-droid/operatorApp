import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import {
  AccountApplicationError, COMPANIES, MAX_UPLOADS_PER_KIND, OPEN_STATUSES, STATUSES, UPLOAD_KINDS, canCreateApplications, companyText,
  effectiveStatus, isAccounting, isAdmin, normalizeInvitation, normalizeSubmission, profilesForOperator, requiredText, uuid, validityDays
} from '../../public/account-applications/domain.js';
import { createCredential, decryptCredential, hashToken } from '../link-credentials.js';
import { validateSignature } from '../mbr/signature.js';
import { validateDeliveryInstructionImageBytes } from '../delivery-instruction-media-validation.js';
import { renderApplicationPdf } from './pdf.js';
import { normalizeLogo } from './logo.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iso = (value) => (value ? new Date(value).toISOString() : null);
const DAY_MS = 86400000;
export const CVV_RETENTION_DAYS = 30;
const CREATING_STALE_MS = 2 * 60 * 1000;
const invalidLink = () => new AccountApplicationError('This application link is unavailable. Please ask your Mr. Bin contact for a new link.', 404, 'ACCOUNT_APPLICATION_LINK_INVALID');
const linkContext = (id) => `account-application:link:v1:${id}`;
const notFound = () => new AccountApplicationError('Application not found.', 404, 'ACCOUNT_APPLICATION_NOT_FOUND');
const forbidden = (message = 'You do not have access to this application.') => new AccountApplicationError(message, 403, 'ACCOUNT_APPLICATION_FORBIDDEN');
const idOf = (value) => { try { return uuid(value, 'Application'); } catch { throw notFound(); } };
const ID_PATTERN = /^\d{1,12}$/u;

// Values read from NetSuite on 2026-11-06; used only if the live option lists cannot be loaded.
export const FALLBACK_OPTIONS = Object.freeze({
  terms: [['1', 'Net 15'], ['2', 'Net 30'], ['3', 'Net 60'], ['4', 'COD'], ['8', '15th MF'], ['10', 'DEPOSIT'], ['11', 'Net 7'],
    ['15', 'Net 16'], ['17', '2% 60 Days'], ['18', '30th MF'], ['21', '30 days']],
  creditLevels: [['1', 'A'], ['2', 'B'], ['3', 'C'], ['4', 'D'], ['5', 'None']],
  priceLevels: [['1', 'Base Price'], ['2', 'TRADE'], ['3', 'TRADE-A'], ['4', 'BUILDER'], ['7', 'RETAIL']],
  statuses: [['13', 'Customer-Closed Won'], ['15', 'Customer-Renewal']],
  salesReps: []
});

async function databaseTime() { return (await query('SELECT clock_timestamp() AS now')).rows[0].now; }

async function event(applicationId, kind, actorId, details = {}) {
  await query('INSERT INTO account_application_events(application_id,kind,actor_id,details) VALUES($1,$2,$3,$4::jsonb)',
    [applicationId, kind, actorId || null, JSON.stringify(details)]);
}

function checkId(value, label, required = true) {
  const text = String(value ?? '').trim();
  if (!text && !required) return '';
  if (!ID_PATTERN.test(text)) throw new AccountApplicationError(`${label} is required.`);
  return text;
}

export function normalizeSettings(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountApplicationError('Settings are required.');
  const maxValidityDays = Number(input.maxValidityDays ?? current.maxValidityDays ?? 30);
  if (!Number.isSafeInteger(maxValidityDays) || maxValidityDays < 1 || maxValidityDays > 90) throw new AccountApplicationError('Maximum link validity must be 1–90 days.');
  const defaultValidityDays = validityDays(input.defaultValidityDays, { maxValidityDays, defaultValidityDays: 7 });
  const profiles = Array.isArray(input.profiles) ? input.profiles : [];
  if (!profiles.length || profiles.length > 20) throw new AccountApplicationError('Add between 1 and 20 company profiles.');
  const keys = new Set();
  const normalized = profiles.map((profile) => {
    const key = String(profile?.key || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,40}$/u.test(key) || keys.has(key)) throw new AccountApplicationError('Each profile needs a unique key (letters, digits, dashes).');
    keys.add(key);
    if (!COMPANIES.includes(profile.company)) throw new AccountApplicationError(`Profile ${key}: choose MBBS, MBT or MBR.`);
    const yard = profile.yardLocationId === null || profile.yardLocationId === '' || profile.yardLocationId === undefined ? null : Number(profile.yardLocationId);
    if (yard !== null && ![1, 28, 15, 26].includes(yard)) throw new AccountApplicationError(`Profile ${key}: choose a valid yard.`);
    if (profile.company === 'MBBS' && yard === null) throw new AccountApplicationError(`Profile ${key}: MBBS profiles need a yard.`);
    const lines = Array.isArray(profile.addressLines) ? profile.addressLines.map((line) => String(line || '').trim()).filter(Boolean) : [];
    if (!lines.length || lines.length > 4) throw new AccountApplicationError(`Profile ${key}: enter 1–4 address lines.`);
    const ns = profile.netsuite || {};
    return {
      key, company: profile.company, label: requiredText(profile.label, `Profile ${key} label`, 80), yardLocationId: yard,
      legalName: requiredText(profile.legalName, `Profile ${key} legal name`, 120),
      addressLines: lines.map((line) => requiredText(line, `Profile ${key} address`, 120)),
      phone: String(profile.phone || '').trim().slice(0, 40), hstNumber: String(profile.hstNumber || '').trim().slice(0, 40),
      active: profile.active !== false,
      netsuite: {
        subsidiaryId: checkId(ns.subsidiaryId, `Profile ${key} NetSuite subsidiary`),
        locationId: checkId(ns.locationId, `Profile ${key} NetSuite location`, false),
        additionalSubsidiaryIds: (Array.isArray(ns.additionalSubsidiaryIds) ? ns.additionalSubsidiaryIds : [])
          .map((value) => checkId(value, `Profile ${key} additional subsidiary`)).slice(0, 5),
        defaultTermsId: checkId(ns.defaultTermsId, `Profile ${key} default terms`, false),
        defaultCreditLevelId: checkId(ns.defaultCreditLevelId, `Profile ${key} default credit level`, false),
        defaultPriceLevelId: checkId(ns.defaultPriceLevelId, `Profile ${key} default price level`, false),
        defaultStatusId: checkId(ns.defaultStatusId, `Profile ${key} default status`, false)
      }
    };
  });
  const texts = (value, fallback, label) => ({
    en: requiredText(value?.en ?? fallback?.en, `${label} (English)`, 2000),
    zh: requiredText(value?.zh ?? fallback?.zh, `${label} (Chinese)`, 2000)
  });
  return { defaultValidityDays, maxValidityDays, profiles: normalized,
    attestation: texts(input.attestation, current.attestation, 'Declaration'),
    cardAuthorization: texts(input.cardAuthorization, current.cardAuthorization, 'Card authorization') };
}

function documentsSummary(uploads) {
  const summary = {};
  for (const kind of UPLOAD_KINDS) {
    const count = uploads.filter((upload) => upload.kind === kind).length;
    summary[kind] = count ? `${count} image${count === 1 ? '' : 's'}` : '';
  }
  return summary;
}

function publicProfile(profile) {
  return { key: profile.key, company: profile.company, label: profile.label, legalName: profile.legalName,
    addressLines: profile.addressLines || [], phone: profile.phone || '', hstNumber: profile.hstNumber || '' };
}

export function createAccountApplicationRepository({ linkKey, vault, netsuite, baseUrl = 'http://localhost:3000', logger = console,
  renderPdf = renderApplicationPdf, validateImage = validateDeliveryInstructionImageBytes } = {}) {
  async function settings() {
    const row = (await query('SELECT revision,data,updated_at FROM account_application_settings WHERE id')).rows[0];
    if (!row) throw new AccountApplicationError('Account applications are not set up.', 503, 'ACCOUNT_APPLICATION_SETUP_MISSING');
    return { revision: row.revision, updatedAt: iso(row.updated_at), ...row.data };
  }

  async function logoMeta(company) {
    const row = (await query('SELECT sha256,width,height,updated_at FROM account_application_logos WHERE company=$1', [company])).rows[0];
    return row ? { url: `/api/account-applications/logos/${company}?v=${row.sha256.slice(0, 12)}`, width: row.width, height: row.height,
      updatedAt: iso(row.updated_at) } : null;
  }
  async function logoBytes(company) {
    return (await query('SELECT image_png FROM account_application_logos WHERE company=$1', [company])).rows[0]?.image_png || null;
  }
  function logoCompany(value) {
    if (!COMPANIES.includes(value)) throw new AccountApplicationError('Choose MBBS, MBT or MBR.', 404, 'ACCOUNT_APPLICATION_LOGO_COMPANY');
    return value;
  }
  async function logo(company) {
    const bytes = await logoBytes(logoCompany(company));
    if (!bytes) throw new AccountApplicationError('No logo uploaded for this company.', 404, 'ACCOUNT_APPLICATION_LOGO_MISSING');
    return { bytes, contentType: 'image/png' };
  }
  async function putLogo(actor, company, bytes) {
    if (!(isAccounting(actor) || isAdmin(actor))) throw forbidden('Accounting or Admin access is required.');
    const normalized = await normalizeLogo(bytes);
    await query(`INSERT INTO account_application_logos(company,image_png,sha256,width,height,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT (company) DO UPDATE SET image_png=EXCLUDED.image_png,sha256=EXCLUDED.sha256,
      width=EXCLUDED.width,height=EXCLUDED.height,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
    [logoCompany(company), normalized.bytes, normalized.sha256, normalized.width, normalized.height, actor.id]);
    return logoMeta(company);
  }
  async function deleteLogo(actor, company) {
    if (!(isAccounting(actor) || isAdmin(actor))) throw forbidden('Accounting or Admin access is required.');
    await query('DELETE FROM account_application_logos WHERE company=$1', [logoCompany(company)]);
    return { company, logo: null };
  }

  async function locked(id, operation) {
    const outcome = await withTransaction(async () => {
      const row = (await query('SELECT * FROM account_applications WHERE id=$1 FOR UPDATE', [idOf(id)])).rows[0];
      if (!row) throw notFound();
      const now = await databaseTime();
      await expireLocked(row, now);
      // Keep the expiry write even when the command itself is rejected.
      try { return { value: await operation(row, now) }; }
      catch (error) { if (error instanceof AccountApplicationError && error.status < 500) return { error }; throw error; }
    });
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  async function expireLocked(row, now) {
    if (effectiveStatus({ status: row.status, expiresAt: row.expires_at }, now) !== 'expired' || row.status === 'expired') return;
    await query("UPDATE account_applications SET status='expired',updated_at=$2 WHERE id=$1", [row.id, now]);
    row.status = 'expired'; row.updated_at = now;
    await event(row.id, 'expired', null, { deadline: iso(row.expires_at) });
  }

  async function tokenLink(token) {
    const link = (await query('SELECT id,application_id,invalidated_at FROM account_application_links WHERE token_hash=$1',
      [hashToken(token, invalidLink)])).rows[0];
    if (!link) throw invalidLink();
    if (link.invalidated_at) throw new AccountApplicationError('This link was replaced by a newer one. Please use the latest link you received.', 410, 'ACCOUNT_APPLICATION_LINK_REPLACED');
    return link;
  }

  function linkResult(row, token) {
    const url = new URL('/account-application', baseUrl); url.hash = token;
    return { url: url.toString(), expiresAt: iso(row.expires_at) };
  }

  async function issueLink(row) {
    const id = randomUUID(), credential = createCredential(await linkKey(), linkContext(row.id), invalidLink);
    await query('INSERT INTO account_application_links(id,application_id,token_hash,encrypted_token) VALUES($1,$2,$3,$4::jsonb)',
      [id, row.id, credential.hash, JSON.stringify(credential.encrypted)]);
    await query('UPDATE account_applications SET active_link_id=$2 WHERE id=$1', [row.id, id]);
    row.active_link_id = id;
    return linkResult(row, credential.token);
  }

  async function uploadsFor(applicationId, { attachedOnly = false } = {}) {
    return (await query(`SELECT id,kind,mime_type,byte_size,attached,created_at FROM account_application_uploads
      WHERE application_id=$1 AND deleted_at IS NULL ${attachedOnly ? 'AND attached' : ''} ORDER BY created_at,id`, [applicationId])).rows;
  }

  async function history(applicationId) {
    return (await query(`SELECT e.kind,e.details,e.created_at,o.display_name AS actor_name FROM account_application_events e
      LEFT JOIN operators o ON o.id=e.actor_id WHERE e.application_id=$1 ORDER BY e.id DESC LIMIT 200`, [applicationId])).rows
      .map((item) => ({ kind: item.kind, details: item.details, at: iso(item.created_at), actorName: item.actor_name || 'Customer / automatic' }));
  }

  async function creatorName(id) {
    return (await query('SELECT display_name FROM operators WHERE id=$1', [id])).rows[0]?.display_name || '';
  }

  function submittedStatus(status) { return ['submitted', 'creating', 'created', 'rejected'].includes(status); }

  async function staffView(row, { review = false } = {}) {
    const status = effectiveStatus({ status: row.status, expiresAt: row.expires_at });
    const uploads = submittedStatus(row.status) ? await uploadsFor(row.id, { attachedOnly: true }) : [];
    const view = {
      id: row.id, number: row.number, status, company: row.company, profileKey: row.profile_key,
      profile: publicProfile(row.profile_snapshot), customerName: row.customer_name, contactPhone: row.contact_phone,
      contactEmail: row.contact_email, note: row.staff_note, createdBy: { id: row.created_by, name: await creatorName(row.created_by) },
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), expiresAt: iso(row.expires_at), openedAt: iso(row.opened_at),
      submittedAt: iso(row.submitted_at), revision: row.revision,
      submission: submittedStatus(row.status) ? {
        legalName: row.legal_name, tradeName: row.trade_name, street: row.street, city: row.city, province: row.province,
        postalCode: row.postal_code, phone: row.phone, email: row.email, nature: row.nature, signerName: row.signer_name,
        signerTitle: row.signer_title, language: row.language
      } : null,
      documents: {
        businessCards: uploads.filter((upload) => upload.kind === 'business_card').map((upload) => ({ id: upload.id, size: upload.byte_size })),
        driversLicenseProvided: uploads.some((upload) => upload.kind === 'drivers_license')
      },
      cardProvided: Boolean(row.card_ref),
      result: { netsuiteCustomerId: row.netsuite_customer_id, netsuiteEntityId: row.approval?.entityId || '', rejectReason: row.reject_reason,
        reviewedAt: iso(row.reviewed_at) },
      history: (await history(row.id)).map((item) => ({ ...item, details: review ? item.details : {} }))
    };
    if (!review) return view;
    return {
      ...view,
      documents: { ...view.documents, driversLicenses: uploads.filter((upload) => upload.kind === 'drivers_license').map((upload) => ({ id: upload.id, size: upload.byte_size })) },
      card: row.card_ref ? { brand: row.card_brand, last4: row.card_last4, expMonth: row.card_exp_month, expYear: row.card_exp_year,
        cvvOnFile: row.card_has_cvv && !row.card_cvv_purged_at && !row.card_deleted_at, cvvPurgedAt: iso(row.card_cvv_purged_at),
        chargedAt: iso(row.card_charged_at), deletedAt: iso(row.card_deleted_at),
        cvvDeadline: row.card_has_cvv && row.submitted_at ? iso(new Date(new Date(row.submitted_at).getTime() + CVV_RETENTION_DAYS * DAY_MS)) : null } : null,
      signatureDataUrl: row.signature_png ? `data:image/png;base64,${row.signature_png.toString('base64')}` : null,
      approval: row.approval, netsuiteError: row.netsuite_error, netsuiteAttemptedAt: iso(row.netsuite_attempted_at),
      defaults: row.profile_snapshot?.netsuite || {}
    };
  }

  function requireCreator(actor) {
    if (!canCreateApplications(actor)) throw forbidden('Sales, MBT front desk, MBR sales or field sales access is required.');
  }
  function requireAccounting(actor) {
    if (!isAccounting(actor)) throw forbidden('Accounting access is required.');
  }
  function requireViewer(actor, row) {
    if (row.created_by === actor.id || isAdmin(actor) || isAccounting(actor)) return;
    throw notFound();
  }
  function requireOpen(row) {
    if (OPEN_STATUSES.includes(row.status)) return;
    if (row.status === 'expired') throw new AccountApplicationError('This link has expired. Please ask your Mr. Bin contact to extend it.', 410, 'ACCOUNT_APPLICATION_EXPIRED');
    if (row.status === 'cancelled') throw new AccountApplicationError('This application was cancelled. Please contact Mr. Bin for help.', 410, 'ACCOUNT_APPLICATION_CANCELLED');
    throw new AccountApplicationError('This application has already been submitted.', 409, 'ACCOUNT_APPLICATION_SUBMITTED');
  }

  // ---------- Staff: create and manage invitations ----------
  async function profiles(actor) {
    requireCreator(actor);
    const current = await settings();
    return { profiles: profilesForOperator(actor, current.profiles).map(publicProfile),
      defaultValidityDays: current.defaultValidityDays, maxValidityDays: current.maxValidityDays };
  }

  async function create(actor, input) {
    requireCreator(actor);
    const current = await settings();
    const fields = normalizeInvitation(input, current);
    const profile = profilesForOperator(actor, current.profiles).find((item) => item.key === fields.profileKey);
    if (!profile) throw forbidden('You cannot create applications for that company.');
    return withTransaction(async () => {
      const now = await databaseTime();
      const row = (await query(`INSERT INTO account_applications(id,company,profile_key,profile_snapshot,customer_name,contact_phone,contact_email,
        staff_note,created_by,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
      [randomUUID(), profile.company, profile.key, JSON.stringify(profile), fields.customerName, fields.contactPhone, fields.contactEmail,
        fields.note, actor.id, new Date(now.getTime() + fields.validityDays * DAY_MS), now])).rows[0];
      await event(row.id, 'created', actor.id, { profileKey: profile.key, validityDays: fields.validityDays });
      const link = await issueLink(row);
      await event(row.id, 'link_issued', actor.id, { expiresAt: link.expiresAt });
      return { application: await staffView(row), link };
    });
  }

  async function list(actor, { search = '', status = '', company = '', offset = 0, limit = 50, review = false } = {}) {
    if (review) requireAccounting(actor); else requireCreator(actor);
    if (typeof search !== 'string' || search.length > 200 || !['', ...STATUSES].includes(status) || !['', ...COMPANIES].includes(company)
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AccountApplicationError('Invalid search.');
    }
    await expireDue();
    const everyone = review || isAdmin(actor);
    const rows = (await query(`SELECT a.id,a.number,a.status,a.company,a.profile_key,a.profile_snapshot->>'label' AS profile_label,
        a.customer_name,a.legal_name,a.expires_at,a.created_at,a.updated_at,a.submitted_at,a.netsuite_customer_id,a.reject_reason,
        (a.card_ref IS NOT NULL AND a.card_deleted_at IS NULL) AS card_on_file, o.display_name AS created_by_name
      FROM account_applications a JOIN operators o ON o.id=a.created_by
      WHERE ($1::boolean OR a.created_by=$2) AND ($3='' OR a.status=$3) AND ($4='' OR a.company=$4)
        AND ($5='' OR a.number ILIKE '%'||$5||'%' OR a.customer_name ILIKE '%'||$5||'%' OR COALESCE(a.legal_name,'') ILIKE '%'||$5||'%'
          OR COALESCE(a.trade_name,'') ILIKE '%'||$5||'%' OR COALESCE(a.phone,'') ILIKE '%'||$5||'%' OR o.display_name ILIKE '%'||$5||'%')
      ORDER BY CASE WHEN $6::boolean AND a.status='submitted' THEN 0 ELSE 1 END, a.updated_at DESC, a.id
      LIMIT $7 OFFSET $8`, [everyone, actor.id, status, company, search.trim(), review, limit + 1, offset])).rows;
    return {
      items: rows.slice(0, limit).map((row) => ({ id: row.id, number: row.number, status: row.status, company: row.company,
        profileKey: row.profile_key, profileLabel: row.profile_label, customerName: row.customer_name, legalName: row.legal_name,
        createdByName: row.created_by_name, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
        submittedAt: iso(row.submitted_at), netsuiteCustomerId: row.netsuite_customer_id, rejectReason: row.reject_reason,
        ...(review ? { cardOnFile: row.card_on_file } : {}) })),
      hasMore: rows.length > limit
    };
  }

  async function get(actor, id) {
    return locked(id, async (row) => { requireViewer(actor, row); return staffView(row); });
  }

  async function link(actor, id, { regenerate = false } = {}) {
    return locked(id, async (row) => {
      requireViewer(actor, row);
      if (!(row.created_by === actor.id || isAdmin(actor))) throw forbidden();
      requireOpen(row);
      if (row.active_link_id && !regenerate) {
        const record = (await query('SELECT encrypted_token FROM account_application_links WHERE id=$1', [row.active_link_id])).rows[0];
        return linkResult(row, decryptCredential(await linkKey(), linkContext(row.id), record.encrypted_token, invalidLink));
      }
      if (row.active_link_id) await query('UPDATE account_application_links SET invalidated_at=clock_timestamp() WHERE id=$1', [row.active_link_id]);
      const result = await issueLink(row);
      await query('UPDATE account_applications SET updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [row.id]);
      await event(row.id, regenerate ? 'link_regenerated' : 'link_issued', actor.id, {});
      return result;
    });
  }

  async function extend(actor, id, input = {}) {
    const current = await settings();
    const days = validityDays(input.validityDays, current);
    return locked(id, async (row, now) => {
      requireViewer(actor, row);
      if (!(row.created_by === actor.id || isAdmin(actor))) throw forbidden();
      if (![...OPEN_STATUSES, 'expired'].includes(row.status)) requireOpen(row);
      const status = row.opened_at ? 'opened' : 'sent';
      const expiresAt = new Date(now.getTime() + days * DAY_MS);
      const previous = iso(row.expires_at);
      Object.assign(row, (await query(`UPDATE account_applications SET status=$2,expires_at=$3,updated_at=$4,revision=revision+1
        WHERE id=$1 RETURNING *`, [row.id, status, expiresAt, now])).rows[0]);
      await event(row.id, 'extended', actor.id, { previousDeadline: previous, deadline: iso(expiresAt), validityDays: days });
      return staffView(row);
    });
  }

  async function cancel(actor, id) {
    const result = await locked(id, async (row, now) => {
      requireViewer(actor, row);
      if (!(row.created_by === actor.id || isAdmin(actor))) throw forbidden();
      if (![...OPEN_STATUSES, 'expired'].includes(row.status)) requireOpen(row);
      // The link stays resolvable so the customer sees "cancelled" rather than "invalid".
      Object.assign(row, (await query(`UPDATE account_applications SET status='cancelled',updated_at=$2,revision=revision+1 WHERE id=$1 RETURNING *`,
        [row.id, now])).rows[0]);
      await event(row.id, 'cancelled', actor.id, {});
      return staffView(row);
    });
    await cleanupAbandoned().catch(() => logger.error('[Account applications] Cleanup after cancel failed.'));
    return result;
  }

  async function pdf(actor, id) {
    return locked(id, async (row) => {
      requireViewer(actor, row);
      if (!row.pdf) throw new AccountApplicationError('The signed application is available after the customer submits it.', 409, 'ACCOUNT_APPLICATION_PDF_PENDING');
      return { bytes: row.pdf, filename: `${row.number}.pdf` };
    });
  }

  async function documentFor(actor, id, uploadId, { review = false } = {}) {
    const uploadKey = uuid(uploadId, 'Document');
    const upload = await locked(id, async (row) => {
      requireViewer(actor, row);
      const found = (await query(`SELECT * FROM account_application_uploads WHERE id=$1 AND application_id=$2 AND deleted_at IS NULL AND attached`,
        [uploadKey, row.id])).rows[0];
      if (!found) throw new AccountApplicationError('Document not found.', 404, 'ACCOUNT_APPLICATION_DOCUMENT_NOT_FOUND');
      if (found.kind === 'drivers_license' && !(review && isAccounting(actor))) throw forbidden("Only Accounting can view driver's licence images.");
      if (review) await event(row.id, 'document_viewed', actor.id, { kind: found.kind, uploadId: found.id });
      return found;
    });
    const result = await vault.getDoc(upload.vault_ref);
    if (result.bytes.length !== upload.byte_size || digest(result.bytes) !== upload.sha256) {
      throw new AccountApplicationError('The stored document failed its integrity check.', 502, 'ACCOUNT_APPLICATION_DOCUMENT_INTEGRITY');
    }
    return { bytes: result.bytes, contentType: upload.mime_type };
  }

  // ---------- Customer (public link) ----------
  async function publicView(token, { markOpened = true } = {}) {
    const credential = await tokenLink(token);
    return locked(credential.application_id, async (row, now) => {
      if (row.active_link_id !== credential.id) throw new AccountApplicationError('This link was replaced by a newer one. Please use the latest link you received.', 410, 'ACCOUNT_APPLICATION_LINK_REPLACED');
      const staffName = await creatorName(row.created_by);
      const letterhead = { ...publicProfile(row.profile_snapshot), logo: await logoMeta(row.company) };
      if (['expired', 'cancelled'].includes(row.status)) {
        return { number: row.number, status: row.status, profile: letterhead, staffName };
      }
      if (submittedStatus(row.status)) {
        return { number: row.number, status: 'submitted', profile: letterhead, staffName,
          submittedAt: iso(row.submitted_at), legalName: row.legal_name, pdfAvailable: Boolean(row.pdf) };
      }
      if (markOpened && row.status === 'sent') {
        await query("UPDATE account_applications SET status='opened',opened_at=$2,updated_at=$2 WHERE id=$1", [row.id, now]);
        row.status = 'opened'; row.opened_at = now;
        await event(row.id, 'opened', null, {});
      }
      const current = await settings();
      const profile = row.profile_snapshot;
      return {
        number: row.number, status: row.status, profile: letterhead, staffName, customerName: row.customer_name,
        expiresAt: iso(row.expires_at),
        attestation: { en: companyText(current.attestation.en, profile), zh: companyText(current.attestation.zh, profile) },
        cardAuthorization: { en: companyText(current.cardAuthorization.en, profile), zh: companyText(current.cardAuthorization.zh, profile) },
        cardVault: { available: vault.configured(), origin: vault.publicOrigin() },
        uploads: (await uploadsFor(row.id)).map((upload) => ({ id: upload.id, kind: upload.kind, size: upload.byte_size }))
      };
    });
  }

  async function publicPdf(token) {
    const credential = await tokenLink(token);
    return locked(credential.application_id, async (row) => {
      if (row.active_link_id !== credential.id) throw invalidLink();
      if (!row.pdf) throw new AccountApplicationError('Your signed application can be downloaded after you submit it.', 409, 'ACCOUNT_APPLICATION_PDF_PENDING');
      return { bytes: row.pdf, filename: `${row.number}.pdf` };
    });
  }

  async function publicUpload(token, { kind, mimeType, bytes }) {
    if (!UPLOAD_KINDS.includes(kind)) throw new AccountApplicationError('Choose what this image is.', 400, 'ACCOUNT_APPLICATION_UPLOAD_KIND');
    const credential = await tokenLink(token);
    const prepared = await locked(credential.application_id, async (row) => {
      if (row.active_link_id !== credential.id) throw invalidLink();
      requireOpen(row);
      const count = Number((await query(`SELECT count(*)::int AS count FROM account_application_uploads
        WHERE application_id=$1 AND kind=$2 AND deleted_at IS NULL`, [row.id, kind])).rows[0].count);
      if (count >= MAX_UPLOADS_PER_KIND) throw new AccountApplicationError(`You can upload up to ${MAX_UPLOADS_PER_KIND} images of each document.`, 409, 'ACCOUNT_APPLICATION_UPLOAD_LIMIT');
      return row;
    });
    if (!vault.configured()) throw new AccountApplicationError('Image upload is temporarily unavailable. You can submit without images and send them to your contact.', 503, 'ACCOUNT_VAULT_NOT_CONFIGURED');
    try { await validateImage(bytes, { mimeType, declaredByteSize: bytes.length }); }
    catch (error) { throw new AccountApplicationError('This image could not be read. Please take the photo again or choose a JPEG/PNG image.', Number(error.status) === 415 ? 415 : 422, 'ACCOUNT_APPLICATION_IMAGE_INVALID'); }
    const ref = randomBytes(24).toString('base64url');
    await vault.putDoc(ref, bytes, mimeType);
    try {
      return await locked(prepared.id, async (row) => {
        requireOpen(row);
        const count = Number((await query(`SELECT count(*)::int AS count FROM account_application_uploads
          WHERE application_id=$1 AND kind=$2 AND deleted_at IS NULL`, [row.id, kind])).rows[0].count);
        if (count >= MAX_UPLOADS_PER_KIND) throw new AccountApplicationError(`You can upload up to ${MAX_UPLOADS_PER_KIND} images of each document.`, 409, 'ACCOUNT_APPLICATION_UPLOAD_LIMIT');
        const upload = (await query(`INSERT INTO account_application_uploads(id,application_id,kind,vault_ref,mime_type,byte_size,sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,kind,byte_size`, [randomUUID(), row.id, kind, ref, mimeType, bytes.length, digest(bytes)])).rows[0];
        return { id: upload.id, kind: upload.kind, size: upload.byte_size };
      });
    } catch (error) {
      await vault.deleteDoc(ref).catch(() => {});
      throw error;
    }
  }

  async function publicDeleteUpload(token, uploadId) {
    const credential = await tokenLink(token);
    const key = uuid(uploadId, 'Upload');
    const upload = await locked(credential.application_id, async (row) => {
      if (row.active_link_id !== credential.id) throw invalidLink();
      requireOpen(row);
      const found = (await query(`UPDATE account_application_uploads SET deleted_at=clock_timestamp()
        WHERE id=$1 AND application_id=$2 AND deleted_at IS NULL RETURNING vault_ref`, [key, row.id])).rows[0];
      if (!found) throw new AccountApplicationError('Image not found.', 404, 'ACCOUNT_APPLICATION_UPLOAD_NOT_FOUND');
      return found;
    });
    await vault.deleteDoc(upload.vault_ref).catch(() => logger.error('[Account applications] Vault document delete failed.'));
    return { deleted: true };
  }

  async function publicCardTicket(token) {
    const credential = await tokenLink(token);
    return locked(credential.application_id, async (row) => {
      if (row.active_link_id !== credential.id) throw invalidLink();
      requireOpen(row);
      if (!vault.configured()) throw new AccountApplicationError('Card details cannot be saved online right now. Submit without a card and your contact will follow up.', 503, 'ACCOUNT_VAULT_NOT_CONFIGURED');
      const ticket = vault.cardPutTicket(row.id);
      return { url: ticket.url, token: ticket.token, expiresAt: ticket.expiresAt };
    });
  }

  async function publicSubmit(token, input, metadata = {}) {
    const credential = await tokenLink(token);
    const data = normalizeSubmission(input);
    const signature = await validateSignature(data.signatureDataUrl);
    const submissionSha = digest(JSON.stringify({ ...data, signatureDataUrl: undefined, signatureSha256: signature.sha256,
      card: data.card ? { ...data.card, receipt: undefined } : null }));
    return locked(credential.application_id, async (row, now) => {
      if (row.active_link_id !== credential.id) throw invalidLink();
      if (submittedStatus(row.status) && row.submission_id === data.submissionId && row.submission_sha256 === submissionSha) {
        return { number: row.number, status: 'submitted', submittedAt: iso(row.submitted_at) };
      }
      requireOpen(row);
      const current = await settings();
      const profile = row.profile_snapshot;
      const uploads = data.uploadIds.length ? (await query(`SELECT id,kind FROM account_application_uploads
        WHERE application_id=$1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`, [row.id, data.uploadIds])).rows : [];
      if (uploads.length !== data.uploadIds.length) throw new AccountApplicationError('An uploaded image is missing. Please upload it again.', 409, 'ACCOUNT_APPLICATION_UPLOAD_MISSING');
      if (data.card) {
        if (!vault.verifyReceipt(row.id, data.card)) throw new AccountApplicationError('The card details could not be verified. Please enter the card again.', 409, 'ACCOUNT_APPLICATION_CARD_INVALID');
        const committed = await vault.commitCard(row.id, data.card.ref);
        if (committed.receipt !== data.card.receipt) throw new AccountApplicationError('The card details changed. Please enter the card again.', 409, 'ACCOUNT_APPLICATION_CARD_CHANGED');
      }
      const language = data.language === 'zh-CN' ? 'zh' : 'en';
      const attestationText = companyText(current.attestation[language], profile);
      const cardAuthorizationText = data.card ? companyText(current.cardAuthorization[language], profile) : null;
      const bytes = await renderPdf({ number: row.number, profile, logo: await logoBytes(row.company), data, signature: signature.bytes, submittedAt: now, attestationText,
        cardAuthorizationText, cardProvided: Boolean(data.card), documents: documentsSummary(uploads) });
      Object.assign(row, (await query(`UPDATE account_applications SET status='submitted',submitted_at=$2,updated_at=$2,revision=revision+1,
        submission_id=$3,submission_sha256=$4,legal_name=$5,trade_name=$6,street=$7,city=$8,province=$9,postal_code=$10,phone=$11,email=$12,
        nature=$13,signer_name=$14,signer_title=$15,language=$16,attestation_text=$17,card_authorization_text=$18,signature_png=$19,
        signature_sha256=$20,submitted_ip=$21,submitted_user_agent=$22,pdf=$23,pdf_sha256=$24,card_ref=$25,card_brand=$26,card_last4=$27,
        card_exp_month=$28,card_exp_year=$29,card_has_cvv=$30 WHERE id=$1 RETURNING *`,
      [row.id, now, data.submissionId, submissionSha, data.legalName, data.tradeName, data.street, data.city, data.province, data.postalCode,
        data.phone, data.email, data.nature, data.signerName, data.signerTitle, data.language, attestationText, cardAuthorizationText,
        signature.bytes, signature.sha256, String(metadata.ip || '').slice(0, 100), String(metadata.userAgent || '').slice(0, 500), bytes,
        digest(bytes), data.card?.ref || null, data.card?.brand || null, data.card?.last4 || null, data.card?.expMonth || null,
        data.card?.expYear || null, Boolean(data.card?.hasCvv)])).rows[0]);
      await query('UPDATE account_application_uploads SET attached=true WHERE application_id=$1 AND id = ANY($2::uuid[])', [row.id, data.uploadIds]);
      await event(row.id, 'submitted', null, { signatureSha256: signature.sha256, pdfSha256: digest(bytes), cardProvided: Boolean(data.card),
        documents: documentsSummary(uploads) });
      return { number: row.number, status: 'submitted', submittedAt: iso(now) };
    });
  }

  // ---------- Accounting review ----------
  async function reviewGet(actor, id) {
    requireAccounting(actor);
    return locked(id, async (row) => staffView(row, { review: true }));
  }

  async function reviewOptions(actor) {
    requireAccounting(actor);
    const live = netsuite ? await netsuite.options().catch(() => ({})) : {};
    const fallback = (key) => FALLBACK_OPTIONS[key].map(([id, name]) => ({ id, name }));
    const pick = (key) => (Array.isArray(live?.[key]) && live[key].length ? live[key] : fallback(key));
    return { terms: pick('terms'), creditLevels: pick('creditLevels'), priceLevels: pick('priceLevels'), statuses: pick('statuses'),
      salesReps: pick('salesReps'), live: Boolean(live?.terms && live?.creditLevels) };
  }

  async function matches(actor, id) {
    requireAccounting(actor);
    const row = await locked(id, async (found) => found);
    if (!row.legal_name) return { items: [], warning: '' };
    return netsuite.findMatches(row);
  }

  async function cardReveal(actor, id) {
    requireAccounting(actor);
    return locked(id, async (row) => {
      if (!row.card_ref || row.card_deleted_at) throw new AccountApplicationError('No card is on file for this application.', 404, 'ACCOUNT_APPLICATION_NO_CARD');
      await event(row.id, 'card_revealed', actor.id, { last4: row.card_last4 });
      return { ...vault.cardRevealTicket(row.id, row.card_ref), purgedAt: iso(row.card_cvv_purged_at) };
    });
  }

  async function cardCharged(actor, id) {
    requireAccounting(actor);
    return locked(id, async (row, now) => {
      if (!row.card_ref || row.card_deleted_at) throw new AccountApplicationError('No card is on file for this application.', 404, 'ACCOUNT_APPLICATION_NO_CARD');
      if (row.card_has_cvv && !row.card_cvv_purged_at) await vault.purgeCvv(row.card_ref);
      Object.assign(row, (await query(`UPDATE account_applications SET card_charged_at=COALESCE(card_charged_at,$2),
        card_cvv_purged_at=CASE WHEN card_has_cvv THEN COALESCE(card_cvv_purged_at,$2) END,updated_at=$2 WHERE id=$1 RETURNING *`, [row.id, now])).rows[0]);
      await event(row.id, 'card_charged', actor.id, {});
      if (row.card_has_cvv) await event(row.id, 'cvv_purged', actor.id, { reason: 'charged' });
      return staffView(row, { review: true });
    });
  }

  async function deleteCardLocked(row, actorId, now, reason) {
    if (!row.card_ref || row.card_deleted_at) return;
    await vault.deleteCard(row.card_ref);
    Object.assign(row, (await query(`UPDATE account_applications SET card_deleted_at=$2,
      card_cvv_purged_at=CASE WHEN card_has_cvv THEN COALESCE(card_cvv_purged_at,$2) END,updated_at=$2 WHERE id=$1 RETURNING *`, [row.id, now])).rows[0]);
    await event(row.id, 'card_deleted', actorId, { reason });
  }

  async function cardDelete(actor, id) {
    requireAccounting(actor);
    return locked(id, async (row, now) => {
      if (!row.card_ref || row.card_deleted_at) throw new AccountApplicationError('No card is on file for this application.', 404, 'ACCOUNT_APPLICATION_NO_CARD');
      await deleteCardLocked(row, actor.id, now, 'accounting');
      return staffView(row, { review: true });
    });
  }

  function normalizeApproval(input = {}) {
    return { termsId: checkId(input.termsId, 'Terms'), creditLevelId: checkId(input.creditLevelId, 'Credit level'),
      priceLevelId: checkId(input.priceLevelId, 'Price level', false), salesRepId: checkId(input.salesRepId, 'Sales rep', false),
      statusId: checkId(input.statusId, 'Customer status'),
      labels: Object.fromEntries(['terms', 'creditLevel', 'priceLevel', 'salesRep', 'status']
        .map((key) => [key, String(input.labels?.[key] || '').slice(0, 120)])) };
  }

  async function approve(actor, id, input) {
    requireAccounting(actor);
    const approval = normalizeApproval(input);
    const claimed = await locked(id, async (row, now) => {
      const stale = row.status === 'creating' && row.netsuite_attempted_at && now - new Date(row.netsuite_attempted_at) > CREATING_STALE_MS;
      if (row.status === 'creating' && !stale) throw new AccountApplicationError('This application is already being created in NetSuite.', 409, 'ACCOUNT_APPLICATION_BUSY');
      if (row.status !== 'submitted' && !stale) throw new AccountApplicationError('Only submitted applications can be approved.', 409, 'ACCOUNT_APPLICATION_NOT_SUBMITTED');
      Object.assign(row, (await query(`UPDATE account_applications SET status='creating',approval=$2::jsonb,reviewed_by=$3,reviewed_at=$4,
        netsuite_attempted_at=$4,netsuite_error=NULL,updated_at=$4,revision=revision+1 WHERE id=$1 RETURNING *`,
      [row.id, JSON.stringify(approval), actor.id, now])).rows[0]);
      await event(row.id, 'approved', actor.id, { approval });
      return row;
    });
    let created;
    try {
      created = await netsuite.createCustomer(claimed, approval);
    } catch (error) {
      const message = String(error?.message || 'NetSuite customer creation failed.').slice(0, 500);
      await withTransaction(async () => {
        await query(`UPDATE account_applications SET status='submitted',netsuite_error=$2,updated_at=clock_timestamp() WHERE id=$1 AND status='creating'`,
          [claimed.id, message]);
        await event(claimed.id, 'netsuite_failed', actor.id, { message });
      });
      throw error instanceof AccountApplicationError ? error : new AccountApplicationError(message, 502, 'ACCOUNT_APPLICATION_NETSUITE_FAILED');
    }
    return withTransaction(async () => {
      const row = (await query(`UPDATE account_applications SET status='created',netsuite_customer_id=$2,netsuite_external_id=$3,
        approval=approval||$4::jsonb,netsuite_error=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [claimed.id, created.customerId, created.externalId, JSON.stringify({ entityId: created.entityId, warnings: created.warnings })])).rows[0];
      await event(row.id, 'netsuite_created', actor.id, { customerId: created.customerId, entityId: created.entityId, warnings: created.warnings });
      return staffView(row, { review: true });
    });
  }

  async function linkExisting(actor, id, input = {}) {
    requireAccounting(actor);
    const customer = await netsuite.customerById(input.customerId);
    return locked(id, async (row, now) => {
      if (row.status !== 'submitted') throw new AccountApplicationError('Only submitted applications can be linked.', 409, 'ACCOUNT_APPLICATION_NOT_SUBMITTED');
      Object.assign(row, (await query(`UPDATE account_applications SET status='created',netsuite_customer_id=$2,approval=$3::jsonb,reviewed_by=$4,
        reviewed_at=$5,netsuite_error=NULL,updated_at=$5,revision=revision+1 WHERE id=$1 RETURNING *`,
      [row.id, customer.id, JSON.stringify({ linkedExisting: true, entityId: customer.entityId }), actor.id, now])).rows[0]);
      await event(row.id, 'linked_existing', actor.id, { customerId: customer.id, entityId: customer.entityId });
      return staffView(row, { review: true });
    });
  }

  async function reject(actor, id, input = {}) {
    requireAccounting(actor);
    const reason = requiredText(input.reason, 'Reason', 500);
    const result = await locked(id, async (row, now) => {
      if (row.status !== 'submitted') throw new AccountApplicationError('Only submitted applications can be rejected.', 409, 'ACCOUNT_APPLICATION_NOT_SUBMITTED');
      await deleteCardLocked(row, actor.id, now, 'rejected');
      const licences = (await query(`UPDATE account_application_uploads SET deleted_at=$2 WHERE application_id=$1 AND kind='drivers_license'
        AND deleted_at IS NULL RETURNING vault_ref`, [row.id, now])).rows;
      for (const licence of licences) await vault.deleteDoc(licence.vault_ref);
      if (licences.length) await event(row.id, 'documents_deleted', actor.id, { kind: 'drivers_license', count: licences.length });
      Object.assign(row, (await query(`UPDATE account_applications SET status='rejected',reject_reason=$2,reviewed_by=$3,reviewed_at=$4,
        updated_at=$4,revision=revision+1 WHERE id=$1 RETURNING *`, [row.id, reason, actor.id, now])).rows[0]);
      await event(row.id, 'rejected', actor.id, { reason });
      return staffView(row, { review: true });
    });
    return result;
  }

  async function getSettings(actor) {
    if (!(isAccounting(actor) || isAdmin(actor))) throw forbidden('Accounting or Admin access is required.');
    const logos = Object.fromEntries(await Promise.all(COMPANIES.map(async (company) => [company, await logoMeta(company)])));
    return { ...(await settings()), logos };
  }

  async function updateSettings(actor, input = {}) {
    if (!(isAccounting(actor) || isAdmin(actor))) throw forbidden('Accounting or Admin access is required.');
    return withTransaction(async () => {
      const row = (await query('SELECT revision,data FROM account_application_settings WHERE id FOR UPDATE')).rows[0];
      if (Number(input.revision) !== row.revision) throw new AccountApplicationError('Settings changed since you opened them. Reload and try again.', 409, 'ACCOUNT_APPLICATION_SETTINGS_CHANGED');
      const data = normalizeSettings(input, row.data);
      await query(`UPDATE account_application_settings SET data=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=clock_timestamp() WHERE id`,
        [JSON.stringify(data), actor.id]);
      return settings();
    });
  }

  async function submittedCount(actor) {
    if (!isAccounting(actor)) return { submitted: 0 };
    return { submitted: Number((await query("SELECT count(*)::int AS count FROM account_applications WHERE status='submitted'")).rows[0].count) };
  }

  // ---------- Maintenance ----------
  async function expireDue() {
    return withTransaction(async () => {
      const rows = (await query(`SELECT * FROM account_applications WHERE status IN ('sent','opened') AND expires_at<=clock_timestamp()
        ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED`)).rows;
      for (const row of rows) await expireLocked(row, await databaseTime());
      return rows.length;
    });
  }

  async function cleanupAbandoned() {
    if (!vault.configured()) return 0;
    const uploads = (await query(`SELECT u.id,u.vault_ref FROM account_application_uploads u JOIN account_applications a ON a.id=u.application_id
      WHERE u.deleted_at IS NULL AND NOT u.attached AND a.status IN ('expired','cancelled') ORDER BY u.created_at LIMIT 100`)).rows;
    for (const upload of uploads) {
      await vault.deleteDoc(upload.vault_ref);
      await query('UPDATE account_application_uploads SET deleted_at=clock_timestamp() WHERE id=$1', [upload.id]);
    }
    return uploads.length;
  }

  async function purgeExpiredCvvs() {
    if (!vault.configured()) return 0;
    const rows = (await query(`SELECT id,card_ref FROM account_applications WHERE card_has_cvv AND card_cvv_purged_at IS NULL
      AND card_deleted_at IS NULL AND submitted_at <= clock_timestamp() - interval '${CVV_RETENTION_DAYS} days' ORDER BY submitted_at LIMIT 100`)).rows;
    for (const row of rows) {
      await vault.purgeCvv(row.card_ref);
      await withTransaction(async () => {
        await query('UPDATE account_applications SET card_cvv_purged_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND card_cvv_purged_at IS NULL', [row.id]);
        await event(row.id, 'cvv_purged', null, { reason: `${CVV_RETENTION_DAYS}-day limit` });
      });
    }
    return rows.length;
  }

  return { settings, profiles, create, list, get, link, extend, cancel, pdf, documentFor, publicView, publicPdf, publicUpload, publicDeleteUpload,
    logo, putLogo, deleteLogo,
    publicCardTicket, publicSubmit, reviewGet, reviewOptions, matches, cardReveal, cardCharged, cardDelete, approve, linkExisting, reject,
    getSettings, updateSettings, submittedCount, expireDue, cleanupAbandoned, purgeExpiredCvvs };
}
