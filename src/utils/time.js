/**
 * Calendar helpers for rewards. Days, weeks, months and "before 8 am" are the
 * runner's local calendar, not the server's: hosts usually run in UTC.
 */

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Africa/Tunis';
const DAY_MS = 24 * 60 * 60 * 1000;

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** Local { year, month (1-12), day, hour } of `date` in APP_TIMEZONE. */
function localParts(date) {
  const parts = {};
  for (const part of partsFormatter.formatToParts(new Date(date))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour };
}

/** "YYYY-MM-DD" of the local day `offsetDays` before `date`. */
function localDayKey(date, offsetDays = 0) {
  const { year, month, day } = localParts(date);
  return new Date(Date.UTC(year, month - 1, day) - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * ISO 8601 week. The week-numbering year differs from the calendar year around
 * New Year: 29 Dec 2025 is week 1 of 2026, 1 Jan 2027 is week 53 of 2026.
 */
function isoWeek(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
  return { isoYear, week };
}

/** Bucket a défi progresses in: "2026-10-21", "2026-W43" or "2026-10". */
function getPeriodId(date, period) {
  const { year, month, day } = localParts(date);
  const mm = String(month).padStart(2, '0');

  if (period === 'mensuel') return `${year}-${mm}`;
  if (period === 'hebdomadaire') {
    const { isoYear, week } = isoWeek(year, month, day);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
  }
  return `${year}-${mm}-${String(day).padStart(2, '0')}`;
}

/** Whole local days left in the period after today (0 on its last day). */
function daysLeftInPeriod(date, period) {
  const { year, month, day } = localParts(date);
  if (period === 'hebdomadaire') {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    return 7 - weekday;
  }
  if (period === 'mensuel') {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return lastDay - day;
  }
  return 0;
}

module.exports = {
  APP_TIMEZONE,
  DAY_MS,
  daysLeftInPeriod,
  getPeriodId,
  isoWeek,
  localDayKey,
  localParts,
};
