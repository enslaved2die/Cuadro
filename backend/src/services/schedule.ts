/**
 * Timezone-aware "next scheduled wall-clock time" calculation.
 *
 * Lets the dashboard configure a refresh time in the display's own local timezone
 * (e.g. 07:00 in America/Bogota) while the server (which may run in a different
 * timezone, e.g. Europe/Berlin) computes how many seconds from now that instant is.
 * The frame itself stays completely unaware of timezones - it only ever receives a
 * plain "sleep for N seconds" instruction via the existing X-Sleep-Seconds header.
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidScheduleTime(time: string): boolean {
  return typeof time === "string" && TIME_PATTERN.test(time);
}

export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || !timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getTzParts(date: Date, timeZone: string): TzParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts: any = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = parseInt(part.value, 10);
  }
  // Some environments render midnight as hour "24" under hour12:false.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

/** Offset in minutes such that (instant + offset) == wall-clock time in `timeZone`. */
function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = getTzParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}

/**
 * Returns the number of seconds from `fromDate` until the next occurrence of a single
 * `time` ("HH:MM") in `timezone`. Always returns a value between 60s and ~24h + a
 * small DST-shift margin.
 */
function secondsUntilTime(time: string, timezone: string, fromDate: Date): number {
  const [targetHour, targetMinute] = time.split(":").map(Number);
  const nowParts = getTzParts(fromDate, timezone);
  const offsetNow = getTimezoneOffsetMinutes(fromDate, timezone);

  // Candidate: today's date (in the target timezone) at the target wall-clock time.
  let candidateUtcMs =
    Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, targetHour, targetMinute, 0) -
    offsetNow * 60000;

  if (candidateUtcMs <= fromDate.getTime()) {
    // Already passed today - move to tomorrow. Recompute the offset for that instant
    // in case a DST transition falls between now and then.
    const tomorrowUtcMs = Date.UTC(
      nowParts.year,
      nowParts.month - 1,
      nowParts.day + 1,
      targetHour,
      targetMinute,
      0
    );
    const approxInstant = new Date(tomorrowUtcMs - offsetNow * 60000);
    const offsetTomorrow = getTimezoneOffsetMinutes(approxInstant, timezone);
    candidateUtcMs = tomorrowUtcMs - offsetTomorrow * 60000;
  }

  const seconds = Math.round((candidateUtcMs - fromDate.getTime()) / 1000);
  return Math.max(60, seconds);
}

/**
 * Returns the number of seconds from `fromDate` until the SOONEST upcoming occurrence
 * among multiple daily `times` ("HH:MM", all interpreted in the same `timezone`) - e.g.
 * refreshing at both 07:00 and 19:00 local to the display. Invalid entries are skipped;
 * if none are valid, falls back to a single 07:00 UTC schedule.
 */
export function secondsUntilNextScheduledTime(
  times: string[] | string,
  timezone: string,
  fromDate: Date = new Date()
): number {
  const timeList = (Array.isArray(times) ? times : [times]).filter(isValidScheduleTime);
  const tz = isValidTimezone(timezone) ? timezone : "UTC";

  if (timeList.length === 0) {
    return secondsUntilTime("07:00", "UTC", fromDate);
  }

  return Math.min(...timeList.map(t => secondsUntilTime(t, tz, fromDate)));
}
