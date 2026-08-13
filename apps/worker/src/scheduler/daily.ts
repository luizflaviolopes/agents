/**
 * Timezone math for 'daily' schedules (migration 0005), built entirely on
 * Intl.DateTimeFormat — no dependencies. DST safety comes from Intl itself:
 * offsets are derived per-instant from the IANA zone database, never assumed
 * constant.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = formatterCache.get(timeZone);
  if (!dtf) {
    // Throws RangeError for invalid IANA names — callers handle it.
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, dtf);
  }
  return dtf;
}

/** The wall-clock reading of a UTC instant in the given zone. */
function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // Some ICU builds report midnight as "24".
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** UTC offset (ms) of the zone at `instant`; zones ahead of UTC are positive. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const w = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - wholeSeconds;
}

/**
 * The UTC instant at which the zone's wall clock reads the given local date
 * and time. Resolved by guessing the offset and re-checking once (converges
 * across DST transitions; inside a spring-forward gap it lands on a nearby
 * valid instant).
 */
function instantForWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zoneOffsetMs(new Date(utcGuess), timeZone);
  let ts = utcGuess - offset1;
  const offset2 = zoneOffsetMs(new Date(ts), timeZone);
  if (offset2 !== offset1) ts = utcGuess - offset2;
  return new Date(ts);
}

/**
 * Next occurrence of `runAtTime` (HH:MM, wall clock in `timezone`) strictly
 * after `from`, falling on one of the allowed `weekdays`
 * (0 = Sunday .. 6 = Saturday, matching schedules.weekdays).
 *
 * Scans up to 8 days ahead starting on `from`'s wall date in the zone, so the
 * time-already-past-today case naturally rolls to the next allowed day. An
 * empty weekday array is treated as "every day" (mirrors the DB default).
 */
export function nextDailyOccurrence(
  runAtTime: string,
  weekdays: number[],
  timezone: string,
  from: Date,
): Date {
  const match = /^(\d{1,2}):(\d{2})/.exec(runAtTime.trim());
  if (!match) {
    throw new Error(`invalid run_at_time "${runAtTime}" (expected HH:MM)`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`invalid run_at_time "${runAtTime}" (expected HH:MM)`);
  }

  const allowed = new Set(
    (weekdays?.length ? weekdays : [0, 1, 2, 3, 4, 5, 6]).map((d) => ((d % 7) + 7) % 7),
  );

  // `from`'s wall date in the zone; day stepping is pure calendar arithmetic
  // on that date (done in UTC space, where every day is exactly DAY_MS).
  const start = wallClockAt(from, timezone);
  const startDateUtc = Date.UTC(start.year, start.month - 1, start.day);

  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const date = new Date(startDateUtc + dayOffset * DAY_MS);
    if (!allowed.has(date.getUTCDay())) continue;
    const candidate = instantForWallClock(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
      timezone,
    );
    if (candidate.getTime() > from.getTime()) return candidate;
  }

  // Unreachable: the allowed set is never empty and 8 days cover every weekday.
  throw new Error(`no occurrence found within 8 days for run_at_time "${runAtTime}"`);
}
