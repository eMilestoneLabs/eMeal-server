/**
 * UNI-002 (Live-Test-5 ISSUE-6): canonical mobile-number normalization.
 *
 * The platform stores Indian mobiles as bare 10-digit national numbers
 * (every existing row), while the signup/login DTOs also accept variants
 * like "+918250364916", "91 8250364916", "0 8250364916" or numbers with
 * spaces/dashes/brackets. Without normalization the SAME real number could
 * register twice (uniqueness bypass) and OTP/login lookups could miss the
 * account the user actually owns.
 *
 * Rules (deliberately conservative — never corrupts unknown formats):
 *   1. Strip whitespace, dashes, dots and brackets.
 *   2. "+91XXXXXXXXXX" / "91XXXXXXXXXX" (12 digits) → "XXXXXXXXXX".
 *   3. "0XXXXXXXXXX" (11 digits, trunk prefix)      → "XXXXXXXXXX".
 *   4. Anything else (including other country codes) is returned as-is
 *      after step 1, so international formats keep working unchanged.
 */
export function normalizePhone(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (cleaned.length === 0) return undefined;

  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^\d+$/.test(digits)) return cleaned;

  // +91 / 91 country prefix on an Indian mobile (first digit 6-9).
  if (digits.length === 12 && digits.startsWith('91') && /[6-9]/.test(digits[2])) {
    return digits.slice(2);
  }
  // Domestic trunk prefix 0.
  if (digits.length === 11 && digits.startsWith('0') && /[6-9]/.test(digits[1])) {
    return digits.slice(1);
  }
  return cleaned.startsWith('+') ? cleaned : digits;
}
