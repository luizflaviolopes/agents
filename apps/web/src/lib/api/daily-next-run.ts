/**
 * Compute the next fire time for a 'daily' schedule: the next occurrence of
 * a wall-clock time in an IANA timezone on an allowed weekday. Used by the
 * schedule API routes when creating or editing daily schedules, so
 * next_run_at is correct from the start; the worker recomputes it the same
 * way after every fire (see ARCHITECTURE.md, migration 0005). Pure
 * Intl-based timezone math — no dependencies.
 */

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock date/time an instant reads as in `timeZone`. */
function wallClockInZone(instant: Date, timeZone: string): WallClock {
  const parts = getPartsFormatter(timeZone).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/**
 * The UTC instant at which `timeZone` reads the given wall-clock time.
 * Guess-and-correct: start from the naive UTC interpretation, then adjust by
 * the observed offset (twice, to converge across DST boundaries).
 */
function zonedWallClockToUtc(wall: WallClock, timeZone: string): Date {
  const target = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const observed = wallClockInZone(new Date(ts), timeZone);
    const observedUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    ts += target - observedUtc;
  }
  return new Date(ts);
}

/** True when `timeZone` is an IANA name Intl can resolve. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    getPartsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Next occurrence of `runAtTime` ("HH:MM", 24h) in `timezone` on an allowed
 * weekday (0 = Sunday .. 6 = Saturday), strictly after `from`. Scans day by
 * day (up to 8 to cover a week plus DST edges); an empty `weekdays` array is
 * treated as all days.
 */
export function computeDailyNextRun(
  runAtTime: string,
  weekdays: number[],
  timezone: string,
  from: Date = new Date(),
): Date {
  const [hour, minute] = runAtTime.split(":").map(Number);
  const allowed = new Set(weekdays.length > 0 ? weekdays : [0, 1, 2, 3, 4, 5, 6]);

  for (let offset = 0; offset <= 8; offset++) {
    // The calendar date `offset` days ahead, as read in the target timezone.
    const probe = wallClockInZone(
      new Date(from.getTime() + offset * 86_400_000),
      timezone,
    );
    // Weekday of that calendar date (date-only, timezone-independent).
    const weekday = new Date(
      Date.UTC(probe.year, probe.month - 1, probe.day),
    ).getUTCDay();
    if (!allowed.has(weekday)) continue;

    const candidate = zonedWallClockToUtc(
      { year: probe.year, month: probe.month, day: probe.day, hour, minute },
      timezone,
    );
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  // Unreachable with a non-empty allowed set; satisfy the compiler anyway.
  throw new Error("Could not compute next daily run");
}
