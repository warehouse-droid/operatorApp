// @ts-check
const invalidArrival = () => Object.assign(new Error('Enter a valid, unambiguous Toronto arrival date and time (YYYY-MM-DD and HH:mm).'), { status: 400, code: 'REGULAR_ARRIVAL_INVALID' });
/** @param {number} value */
const pad = value => String(value).padStart(2, '0');
const toronto = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** @param {unknown} dateInput @param {unknown} timeInput */
export function normalizeRegularArrival(dateInput, timeInput) {
  const rawDate = String(dateInput ?? '').trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(rawDate);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(rawDate);
  const values=iso?iso.slice(1):us?[us[3],us[1],us[2]]:null;
  if(!values)throw invalidArrival();
  const [year,month,day]=values.map(Number);
  const date = `${year}-${pad(month)}-${pad(day)}`;
  const rawTime = String(timeInput ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(rawTime);
  const compact = /^(\d{2})(\d{2})$/.exec(rawTime);
  const parsed=match||compact;
  if (!parsed) throw invalidArrival();
  let hour = Number(parsed[1]);
  const minute = Number(parsed[2] || 0);
  if (match?.[3]) {
    if (hour < 1 || hour > 12) throw invalidArrival();
    hour = hour % 12 + (match[3] === 'pm' ? 12 : 0);
  }
  if (year < 1000 || year > 9999 || hour > 23 || minute > 59) throw invalidArrival();
  const time = `${pad(hour)}:${pad(minute)}`;
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(naive).toISOString().slice(0, 10) !== date) throw invalidArrival();
  // Resolve wall time through Intl; zero/two matches are the DST gap/fold.
  const candidates = [];
  for (let offset = -14; offset <= 14; offset += 1) {
    const instant = new Date(naive + offset * 3600000);
    const parts = Object.fromEntries(toronto.formatToParts(instant).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === date && `${parts.hour}:${parts.minute}` === time) candidates.push(instant);
  }
  if (candidates.length !== 1) throw invalidArrival();
  return { date, time, arrivalAt: candidates[0].toISOString(), timeZone: 'America/Toronto' };
}

/** @param {unknown} [value] */
export function normalizeRegularLeadHours(value = 5) {
  if (value === null || typeof value === 'boolean' || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 87600) {
    throw Object.assign(new Error('Minimum auto-approval lead hours must be a number between 0 and 87600.'), { status: 400, code: 'REGULAR_LEAD_HOURS_INVALID' });
  }
  return Number(value);
}

/** @param {unknown} [value] */
export function normalizeRegularApprovalMinutes(value = 15) {
  if(value===null || typeof value==='boolean' || String(value).trim()==='' || !Number.isInteger(Number(value)) || Number(value)<1 || Number(value)>10080) {
    throw Object.assign(new Error('Approval validity must be a whole number between 1 and 10080 minutes.'),{status:400,code:'REGULAR_APPROVAL_MINUTES_INVALID'});
  }
  return Number(value);
}
