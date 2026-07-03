/**
 * date.utils.ts — shared date/time utilities for the eMeal backend.
 *
 * All utilities operate in UTC to guarantee timezone-consistent attendance records
 * regardless of server locale. Attendance windows are converted to org-local time
 * only for comparison, not for storage.
 *
 * Governance rule (Timezone Governance):
 *   - ALL dates stored in DB are UTC.
 *   - attendanceDate is always UTC midnight of the calendar date.
 *   - attendance window open/close are HH:mm strings — compared in org timezone.
 *   - NEVER use `new Date(dateStr)` without explicit UTC parsing for YYYY-MM-DD strings.
 */

/**
 * Parse a YYYY-MM-DD date string into a UTC midnight Date object.
 *
 * Why not `new Date(dateStr)`?
 *   While V8/Node.js parses ISO date-only strings as UTC per spec, this is
 *   version-dependent behaviour. Using explicit Date.UTC() is defensive,
 *   consistent with all other date construction in this codebase, and makes
 *   intent clear.
 *
 * @example toUtcMidnight('2026-05-27') // → 2026-05-27T00:00:00.000Z
 */
export function toUtcMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/**
 * Get the current time as HH:mm in the given IANA timezone.
 * Uses Intl.DateTimeFormat — no external library required.
 *
 * @example getCurrentTimeInTimezone('Asia/Kolkata') // → "08:30"
 */
export function getCurrentTimeInTimezone(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());

    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${hour}:${minute}`;
  } catch {
    // Fallback to UTC if timezone is invalid
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/** Convert HH:mm to minutes since midnight. */
function hhmmToMinutesSinceMidnight(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Check whether a HH:mm time string falls within an open–close window.
 * Compares by total minutes since midnight — no date ambiguity.
 *
 * SRS FR-TIME-002 (LOOP-023): boundaries are inclusive of `open` and
 * EXCLUSIVE of `close` (`open ≤ now < close`) — marking exactly at close is
 * rejected unless a grace period applies.
 * SRS FR-TIME-005 (LOOP-090): an optional per-group `graceMinutes` extends
 * the close boundary (`now < close + grace`).
 *
 * @example isWithinWindow('08:15', '07:00', '09:00') // → true
 * @example isWithinWindow('09:00', '07:00', '09:00') // → false (close-exclusive)
 * @example isWithinWindow('09:05', '07:00', '09:00', 10) // → true (grace)
 */
export function isWithinWindow(
  time: string,
  open: string,
  close: string,
  graceMinutes = 0,
): boolean {
  const t = hhmmToMinutesSinceMidnight(time);
  const o = hhmmToMinutesSinceMidnight(open);
  const c = hhmmToMinutesSinceMidnight(close);
  return t >= o && t < c + Math.max(0, graceMinutes);
}

/**
 * SRS FR-TIME-008 — canonical window state exposed to clients:
 *   upcoming (now < open) · open (open ≤ now < close) ·
 *   grace (close ≤ now < close+grace) · closed (now ≥ effective close).
 */
export type AttendanceWindowState = 'upcoming' | 'open' | 'grace' | 'closed';

export function getWindowState(
  time: string,
  open: string | null,
  close: string | null,
  graceMinutes = 0,
): AttendanceWindowState {
  // FR-TIME-001 documented default: a meal with no window is always-open
  // for the date.
  if (!open || !close) return 'open';
  const t = hhmmToMinutesSinceMidnight(time);
  const o = hhmmToMinutesSinceMidnight(open);
  const c = hhmmToMinutesSinceMidnight(close);
  const g = Math.max(0, graceMinutes);
  if (t < o) return 'upcoming';
  if (t < c) return 'open';
  if (t < c + g) return 'grace';
  return 'closed';
}

/**
 * Format a Date as a YYYY-MM-DD string in UTC.
 * Used for cache keys and export filenames.
 *
 * @example formatUtcDate(new Date('2026-05-27T08:30:00Z')) // → "2026-05-27"
 */
export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
