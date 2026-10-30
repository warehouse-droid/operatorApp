export const AGGREGATE_SOURCE_FILTER = 'pending_fulfillment_aggregate';
// Exact catalog families, shared by PostgreSQL and the executable classifier.
// Do not broaden this to a substring search for sand, gravel or limestone.
export const AGGREGATE_ITEM_PATTERN = '^(([0-9]+-)?aggregate-(screening|hpb|3/4 clear limestone|crusher run|concrete sand|hl6|concrete stone)|brick sand|river rock|bag sand (20|25)kg|(small|bulk) bag (gravel|screening|hpb|brick sand|river rock|crush run))$';
const materialPattern = new RegExp(AGGREGATE_ITEM_PATTERN, 'i');

/** @param {string} name */
export function isAggregateMaterial(name) {
  return materialPattern.test(name.trim().replace(/\s+/g, ' '));
}

/** @typedef {{aggregateNightlyEnabled?: boolean, aggregateNightlyTime?: string, soInitialDryRunApprovedAt?: unknown}} Settings */
/** @typedef {{scheduledLocalDate: string, status?: string}} LastRun */
/** @param {Settings} settings @param {LastRun|null} lastRun @param {Date} [now] */
export function aggregateNightlySchedule(settings, lastRun, now = new Date()) {
  const timeZone = 'America/Toronto';
  const localTime = settings.aggregateNightlyTime || '21:30';
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const localDate = `${values.year}-${values.month}-${values.day}`;
  if (!settings.aggregateNightlyEnabled) { return { reason: 'disabled', localDate, nextRun: null }; }
  if (!settings.soInitialDryRunApprovedAt) { return { reason: 'initial_so_not_approved', localDate, nextRun: null }; }
  const attempted = Boolean(lastRun && lastRun.scheduledLocalDate >= localDate);
  const nextDate = new Date(`${attempted && lastRun ? lastRun.scheduledLocalDate : localDate}T12:00:00Z`);
  if (attempted) { nextDate.setUTCDate(nextDate.getUTCDate() + 1); }
  const reason = attempted ? 'already_attempted'
    : `${values.hour}:${values.minute}` < localTime ? 'before_scheduled_time' : 'due';
  return { reason, localDate, nextRun: { localDate: nextDate.toISOString().slice(0, 10), localTime, timeZone } };
}
