// Shared (browser + server) rules for customer account applications.

export class AccountApplicationError extends Error {
  constructor(message, status = 400, code = 'ACCOUNT_APPLICATION_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const COMPANIES = Object.freeze(['MBBS', 'MBT', 'MBR']);
export const NATURES = Object.freeze(['renovation', 'landscaping']);
export const UPLOAD_KINDS = Object.freeze(['business_card', 'drivers_license']);
export const MAX_UPLOADS_PER_KIND = 2;
export const OPEN_STATUSES = Object.freeze(['sent', 'opened']);
export const STATUSES = Object.freeze(['sent', 'opened', 'submitted', 'creating', 'created', 'rejected', 'expired', 'cancelled']);
export const PROVINCES = Object.freeze([
  ['ON', 'Ontario', '安大略省'], ['QC', 'Quebec', '魁北克省'], ['BC', 'British Columbia', '不列颠哥伦比亚省'],
  ['AB', 'Alberta', '阿尔伯塔省'], ['MB', 'Manitoba', '曼尼托巴省'], ['SK', 'Saskatchewan', '萨斯喀彻温省'],
  ['NS', 'Nova Scotia', '新斯科舍省'], ['NB', 'New Brunswick', '新不伦瑞克省'], ['NL', 'Newfoundland and Labrador', '纽芬兰与拉布拉多省'],
  ['PE', 'Prince Edward Island', '爱德华王子岛省'], ['NT', 'Northwest Territories', '西北地区'], ['NU', 'Nunavut', '努纳武特地区'],
  ['YT', 'Yukon', '育空地区']
]);
const PROVINCE_CODES = new Set(PROVINCES.map(([code]) => code));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const EMAIL = /^[^\s@<>(),;:\\"]+@[^\s@<>(),;:\\"]+\.[^\s@<>(),;:\\"]+$/u;

const blank = (value) => value === null || value === undefined || (typeof value === 'string' && !value.trim());

export function requiredText(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || CONTROL.test(value)) {
    throw new AccountApplicationError(`${label} is required (at most ${maximum} characters).`);
  }
  return value.trim().replace(/\s+/gu, ' ');
}

export function optionalText(value, label, maximum = 200) {
  return blank(value) ? '' : requiredText(value, label, maximum);
}

export function normalizeEmail(value, label = 'Email', required = true) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email && !required) return '';
  if (!email || email.length > 254 || !EMAIL.test(email)) throw new AccountApplicationError(`${label}: enter a valid email address.`);
  return email;
}

export function normalizePhone(value, label = 'Phone', required = true) {
  const text = String(value ?? '').trim();
  if (!text && !required) return '';
  const [main, extension = ''] = text.split(/\s*(?:ext\.?|x|#)\s*/iu);
  let digits = String(main || '').replace(/\D/gu, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  const ext = extension.replace(/\D/gu, '');
  if (!/^[2-9]\d{2}[2-9]\d{6}$/u.test(digits) || ext.length > 6 || text.length > 40) {
    throw new AccountApplicationError(`${label}: enter a 10-digit phone number.`);
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}${ext ? ` ext ${ext}` : ''}`;
}

export function normalizePostalCode(value) {
  const compact = String(value ?? '').toUpperCase().replace(/[\s-]/gu, '');
  if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/u.test(compact)) {
    throw new AccountApplicationError('Postal code: enter a valid Canadian postal code (e.g. M1V 4Y3).');
  }
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

export function uuid(value, label = 'Identifier') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AccountApplicationError(`${label} is invalid.`);
  return value.toLowerCase();
}

export function validityDays(value, settings) {
  const maximum = Number(settings?.maxValidityDays) || 30;
  const days = blank(value) ? Number(settings?.defaultValidityDays) || 7 : Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > maximum) {
    throw new AccountApplicationError(`Link validity must be between 1 and ${maximum} days.`);
  }
  return days;
}

export function normalizeInvitation(input, settings) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountApplicationError('Application details are required.');
  return {
    customerName: requiredText(input.customerName, 'Customer name', 200),
    profileKey: requiredText(input.profileKey, 'Company', 40),
    validityDays: validityDays(input.validityDays, settings),
    contactPhone: normalizePhone(input.contactPhone, 'Customer phone', false),
    contactEmail: normalizeEmail(input.contactEmail, 'Customer email', false),
    note: optionalText(input.note, 'Note', 500)
  };
}

function normalizeCardSummary(card) {
  if (card === null || card === undefined) return null;
  if (typeof card !== 'object' || Array.isArray(card)) throw new AccountApplicationError('Card details are invalid.');
  const expMonth = Number(card.expMonth), expYear = Number(card.expYear);
  if (typeof card.ref !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(card.ref)
      || typeof card.receipt !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/u.test(card.receipt)
      || typeof card.brand !== 'string' || card.brand.length > 40 || !/^\d{4}$/u.test(String(card.last4 || ''))
      || !Number.isSafeInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isSafeInteger(expYear)
      || expYear < 2000 || expYear > 2100 || typeof card.hasCvv !== 'boolean') {
    throw new AccountApplicationError('Card details are invalid. Enter the card again.');
  }
  return { ref: card.ref, receipt: card.receipt, brand: card.brand, last4: card.last4, expMonth, expYear, hasCvv: card.hasCvv };
}

export function normalizeSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountApplicationError('Application details are required.');
  const nature = Array.isArray(input.nature) ? [...new Set(input.nature.map(String))] : [];
  if (!nature.length || nature.some((value) => !NATURES.includes(value))) {
    throw new AccountApplicationError('Select the nature of your business (Renovation and/or Landscaping).');
  }
  const province = String(input.province || '').trim().toUpperCase();
  if (!PROVINCE_CODES.has(province)) throw new AccountApplicationError('Select a province.');
  const uploadIds = Array.isArray(input.uploadIds) ? input.uploadIds : [];
  if (uploadIds.length > UPLOAD_KINDS.length * MAX_UPLOADS_PER_KIND) throw new AccountApplicationError('Too many uploaded images.');
  if (input.attestationAccepted !== true) throw new AccountApplicationError('Please confirm the declaration before signing.');
  const card = normalizeCardSummary(input.card);
  if (card && input.cardAuthorized !== true) throw new AccountApplicationError('Please authorize the card on file, or remove the card.');
  const language = input.language === 'zh-CN' ? 'zh-CN' : 'en';
  const legalName = requiredText(input.legalName, 'Legal name', 200);
  const tradeName = optionalText(input.tradeName, 'Business trade name', 200);
  return {
    submissionId: uuid(input.submissionId, 'Submission'),
    legalName,
    tradeName: tradeName && tradeName.toLowerCase() !== legalName.toLowerCase() ? tradeName : '',
    street: requiredText(input.street, 'Street address', 200),
    city: requiredText(input.city, 'City', 100),
    province,
    postalCode: normalizePostalCode(input.postalCode),
    phone: normalizePhone(input.phone, 'Phone'),
    email: normalizeEmail(input.email, 'Email'),
    nature: NATURES.filter((value) => nature.includes(value)),
    signerName: requiredText(input.signerName, 'Print name', 100),
    signerTitle: requiredText(input.signerTitle, 'Title', 100),
    signatureDataUrl: typeof input.signatureDataUrl === 'string' ? input.signatureDataUrl : '',
    uploadIds: [...new Set(uploadIds.map((value) => uuid(value, 'Upload')))],
    card,
    cardAuthorized: Boolean(card),
    attestationAccepted: true,
    language
  };
}

export function effectiveStatus(application, now = new Date()) {
  return OPEN_STATUSES.includes(application.status) && application.expiresAt
    && new Date(application.expiresAt).getTime() <= now.getTime() ? 'expired' : application.status;
}

export function rolesOf(operator) {
  return new Set([operator?.role, ...(Array.isArray(operator?.roles) ? operator.roles : [])]
    .filter(Boolean).map((value) => String(value).trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')));
}

export const isAccounting = (operator) => rolesOf(operator).has('accounting');
export const isAdmin = (operator) => rolesOf(operator).has('admin');
export const canManageSettings = (operator) => isAccounting(operator) || isAdmin(operator);

// Which company profiles this staff member may create applications for.
export function profilesForOperator(operator, profiles = []) {
  const roles = rolesOf(operator);
  const active = profiles.filter((profile) => profile.active !== false);
  if (roles.has('admin') || roles.has('field_sales')) return active;
  const yards = new Set((operator?.yardLocationIds || []).map(Number));
  return active.filter((profile) => (roles.has('sales') && profile.company === 'MBBS' && yards.has(Number(profile.yardLocationId)))
    || (roles.has('mbt_frontdesk') && profile.company === 'MBT')
    || (roles.has('mbr_sales') && profile.company === 'MBR'));
}

export function canCreateApplications(operator) {
  const roles = rolesOf(operator);
  return ['admin', 'field_sales', 'sales', 'mbt_frontdesk', 'mbr_sales'].some((role) => roles.has(role));
}

export function companyText(template, profile) {
  return String(template || '').replaceAll('{company}', profile?.legalName || 'the company');
}

export function maskCard(card) {
  return card?.last4 ? `${card.brand || 'Card'} •••• ${card.last4} · exp ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` : '';
}
