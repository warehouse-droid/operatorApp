// @ts-check
/** @typedef {{role?:string,roles?:string[]}} Staff */
/** @typedef {{effectiveDate:string|null,lessee:string|null,equipmentModel:string|null,serialNumber:string|null,
 * rentalStart:string|null,rentalEnd:string|null,pickupLocation:string|null,returnLocation:string|null,
 * dailyRateMinor:number|null,weeklyRateMinor:number|null,monthlyRateMinor:number|null,securityDepositMinor:number|null,expiryDays:number|null}} ContractFields */
export class MbrError extends Error {
  /** @param {string} message @param {number} [status] @param {string} [code] */
  constructor(message, status = 400, code = 'MBR_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
/** @param {unknown} value */
export function moneyMinor(value) {
  const amount = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,10}(?:\.\d{1,2})?$/u.test(amount)) {
    throw new MbrError('Enter a valid CAD amount with at most two decimal places.');
  }
  const [whole = '', fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** @param {unknown} value @param {string} label @param {number} [maximum] */
export function requiredText(value, label, maximum = 300) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MbrError(`${label} is required and must be no longer than ${maximum} characters.`);
  }
  return value.trim();
}

/** @param {unknown} value */
function blank(value) {
  return value===null || value===undefined || (typeof value==='string' && !value.trim());
}
/** @param {unknown} value @param {string} label @param {number} [maximum] */
function optionalText(value,label,maximum=300) {
  return blank(value)?null:requiredText(value,label,maximum);
}
/** @param {unknown} value */
function optionalMoney(value) {return blank(value)?null:moneyMinor(value);}
/** @param {unknown} value */
function contractExpiry(value) {
  if(blank(value)) {return null;}
  if(typeof value!=='number' || !Number.isSafeInteger(value) || value<1) {
    throw new MbrError('Expiry must be a positive whole number of days.');
  }
  expiryDeadline(new Date(),value);
  return value;
}

/** @param {unknown} value @param {string} label */
function calendarDate(value, label) {
  const date = optionalText(value, label, 10);
  if(date===null) {return null;}
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== date) {
    throw new MbrError(`${label} must be a valid calendar date.`);
  }
  return date;
}

/** @param {unknown} input @returns {ContractFields} */
export function normalizeContractFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MbrError('Contract details are required.');
  }
  const data = /** @type {Record<string,unknown>} */ (input);
  const expiryDays = contractExpiry(data.expiryDays);
  const rentalStart = calendarDate(data.rentalStart, 'Rental start date');
  const rentalEnd = calendarDate(data.rentalEnd, 'Rental end date');
  if (rentalStart && rentalEnd && rentalEnd < rentalStart) {throw new MbrError('Rental end date must be on or after the start date.');}
  return {
    effectiveDate: calendarDate(data.effectiveDate, 'Effective date'),
    lessee: optionalText(data.lessee, 'Lessee'),
    equipmentModel: optionalText(data.equipmentModel, 'Equipment model'),
    serialNumber: optionalText(data.serialNumber, 'Serial number', 150),
    rentalStart, rentalEnd,
    pickupLocation: optionalText(data.pickupLocation, 'Pickup location', 500),
    returnLocation: optionalText(data.returnLocation, 'Return location', 500),
    dailyRateMinor: optionalMoney(data.dailyRate), weeklyRateMinor: optionalMoney(data.weeklyRate),
    monthlyRateMinor: optionalMoney(data.monthlyRate), securityDepositMinor: optionalMoney(data.securityDeposit),
    expiryDays
  };
}

/** @param {Date} now @param {number} days */
export function expiryDeadline(now, days) {
  const deadline = new Date(now.getTime() + days * 86400000);
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isFinite(deadline.getTime())) {
    throw new MbrError('Expiry must be a valid positive whole number of days.');
  }
  return deadline.toISOString();
}

/** @param {{status:string,expiresAt:Date|string|null}} contract @param {Date} now */
export function effectiveStatus(contract, now) {
  return contract.status === 'pending' && contract.expiresAt
    && new Date(contract.expiresAt).getTime() <= now.getTime() ? 'expired' : contract.status;
}

/** @param {Staff|null|undefined} operator */
function rolesOf(operator) {
  return new Set([operator?.role, ...(Array.isArray(operator?.roles) ? operator.roles : [])]
    .filter(Boolean).map(value => String(value).trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')));
}

/** @param {Staff|null|undefined} operator */
export function isMbrOnly(operator) {
  const roles = rolesOf(operator);
  return roles.size === 1 && roles.has('mbr_sales');
}

/** @param {Staff|null|undefined} operator @param {string} pathname */
export function staffPathAllowed(operator, pathname) {
  if (!isMbrOnly(operator)) {return true;}
  return pathname.startsWith('/api/mbr/')
    || ['/api/auth/me', '/api/auth/logout'].includes(pathname);
}

/** @param {Staff|null|undefined} operator */
export function requireMbrAuthority(operator) {
  const roles = rolesOf(operator);
  if (!roles.has('mbr_sales') && !roles.has('admin')) {
    throw new MbrError('MBR Sales access is required.', 403, 'MBR_FORBIDDEN');
  }
}

/** @param {unknown} input */
export function normalizeSigningRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {throw new MbrError('Signing details are required.');}
  const data = /** @type {Record<string,unknown>} */ (input);
  const allowed = ['revision','protectionPlanAccepted','consent','signerName','signatureDataUrl','submissionId'];
  if (Object.keys(data).some(key => !allowed.includes(key))) {throw new MbrError('Unexpected signing fields.');}
  if (typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 1) {
    throw new MbrError('Review the current agreement before signing.');
  }
  if (typeof data.protectionPlanAccepted !== 'boolean') {throw new MbrError('Choose whether to accept or decline the protection plan.');}
  if (data.consent !== true) {throw new MbrError('Confirm that you agree to the full rental agreement.');}
  const submissionId = requiredText(data.submissionId, 'Signing submission', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(submissionId)) {
    throw new MbrError('Invalid signing submission.');
  }
  if (typeof data.signatureDataUrl !== 'string') {throw new MbrError('Draw your signature.');}
  return {revision:data.revision, protectionPlanAccepted:data.protectionPlanAccepted, consent:true,
    signerName:requiredText(data.signerName, 'Signer name'), signatureDataUrl:data.signatureDataUrl,
    submissionId:submissionId.toLowerCase()};
}

/** @param {number|null|undefined} cents */
export function formatMoney(cents) {
  if(cents===null || cents===undefined) {return '';}
  return new Intl.NumberFormat('en-CA', {style:'currency',currency:'CAD'}).format(cents / 100);
}

/** @param {string|null|undefined} start @param {string|null|undefined} end */
export function formatRentalPeriod(start,end) {
  if(start && end) {return `${start} to ${end}`;}
  if(start) {return `From ${start}`;}
  return end?`Until ${end}`:'';
}

/** @param {string|null|undefined} value */
export function formatDeadline(value) {
  return value ? new Intl.DateTimeFormat('en-CA', {timeZone:'America/Toronto',dateStyle:'medium',timeStyle:'short'})
    .format(new Date(value)) + ' (Toronto time)' : 'Starts when the link is generated';
}
