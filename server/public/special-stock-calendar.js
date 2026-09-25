/** Ontario's nine public holidays with next-available-weekday observances. */
/** @type {Map<number, Set<string>>} */
const cache = new Map();
/** @param {Date} date */
const iso = date => date.toISOString().slice(0, 10);
/** @param {number} year @param {number} month @param {number} day */
const dateAt = (year, month, day) => new Date(Date.UTC(year, month - 1, day, 12));
/** @param {number} year @param {number} month @param {number} occurrence */
function monday(year, month, occurrence) {
  const first = dateAt(year, month, 1);
  return dateAt(year, month, 1 + (8 - first.getUTCDay()) % 7 + (occurrence - 1) * 7);
}
/** Gregorian Easter computus. @param {number} year */
function goodFriday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const value = h + l - 7 * m + 114;
  return dateAt(year, Math.floor(value / 31), value % 31 + 1 - 2);
}
/** @param {number} year */
export function ontarioSpecialHolidays(year) {
  if (cache.has(year)) return new Set(cache.get(year));
  const victoria = dateAt(year, 5, 24);
  victoria.setUTCDate(24 - (victoria.getUTCDay() + 6) % 7);
  const dates = [dateAt(year, 1, 1), monday(year, 2, 3), goodFriday(year), victoria,
    dateAt(year, 7, 1), monday(year, 9, 1), monday(year, 10, 2), dateAt(year, 12, 25), dateAt(year, 12, 26)];
  const holidays = new Set(dates.map(iso));
  for (const holiday of dates) {
    if (![0, 6].includes(holiday.getUTCDay())) continue;
    const observed = new Date(holiday);
    do { observed.setUTCDate(observed.getUTCDate() + 1); }
    while ([0, 6].includes(observed.getUTCDay()) || holidays.has(iso(observed)));
    holidays.add(iso(observed));
  }
  cache.set(year, holidays);
  return new Set(holidays);
}

/** @param {Date} date */
export function isSpecialWorkingDay(date) {
  return ![0, 6].includes(date.getUTCDay()) && !ontarioSpecialHolidays(date.getUTCFullYear()).has(iso(date));
}
