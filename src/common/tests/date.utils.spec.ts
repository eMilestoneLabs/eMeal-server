import {
  toUtcMidnight,
  getCurrentTimeInTimezone,
  isWithinWindow,
  formatUtcDate,
} from '../utils/date.utils';

describe('date.utils', () => {
  describe('toUtcMidnight', () => {
    it('parses YYYY-MM-DD to UTC midnight', () => {
      expect(toUtcMidnight('2026-05-27').toISOString()).toBe('2026-05-27T00:00:00.000Z');
    });
    it('handles single-digit month/day', () => {
      expect(toUtcMidnight('2026-01-05').toISOString()).toBe('2026-01-05T00:00:00.000Z');
    });
  });

  describe('isWithinWindow', () => {
    it('returns true inside the window', () => {
      expect(isWithinWindow('08:15', '07:00', '09:00')).toBe(true);
    });
    it('returns false outside the window', () => {
      expect(isWithinWindow('10:00', '07:00', '09:00')).toBe(false);
      expect(isWithinWindow('06:59', '07:00', '09:00')).toBe(false);
    });
    // SRS FR-TIME-002 (LOOP-023): open-inclusive, close-EXCLUSIVE.
    it('is inclusive of open and exclusive of close', () => {
      expect(isWithinWindow('07:00', '07:00', '09:00')).toBe(true);
      expect(isWithinWindow('09:00', '07:00', '09:00')).toBe(false);
      expect(isWithinWindow('08:59', '07:00', '09:00')).toBe(true);
    });
    // SRS FR-TIME-005 (LOOP-090): grace extends the close boundary.
    it('honours a grace period past close', () => {
      expect(isWithinWindow('09:00', '07:00', '09:00', 10)).toBe(true);
      expect(isWithinWindow('09:09', '07:00', '09:00', 10)).toBe(true);
      expect(isWithinWindow('09:10', '07:00', '09:00', 10)).toBe(false);
      expect(isWithinWindow('09:00', '07:00', '09:00', -5)).toBe(false);
    });
  });

  describe('formatUtcDate', () => {
    it('formats a Date to YYYY-MM-DD in UTC', () => {
      expect(formatUtcDate(new Date('2026-05-27T08:30:00Z'))).toBe('2026-05-27');
    });
    it('ignores local time and uses UTC date', () => {
      expect(formatUtcDate(new Date('2026-12-31T23:00:00Z'))).toBe('2026-12-31');
    });
  });

  describe('getCurrentTimeInTimezone', () => {
    it('returns HH:mm for a valid IANA timezone', () => {
      expect(getCurrentTimeInTimezone('Asia/Kolkata')).toMatch(/^\d{2}:\d{2}$/);
    });
    it('falls back to a valid HH:mm for an invalid timezone', () => {
      expect(getCurrentTimeInTimezone('Not/AZone')).toMatch(/^\d{2}:\d{2}$/);
    });
  });
});
