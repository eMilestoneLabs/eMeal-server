import { registerAs } from '@nestjs/config';

/**
 * Auth / OTP configuration — centralizes every tunable used by the
 * Authentication & Onboarding module so nothing is hardcoded (SRS Part 7,
 * CONFIGURATION mandate). All values are environment-overridable.
 *
 * Backed requirements:
 *   AUTH-038 / SEC-007 — OTP validity period is administrator-configurable and OTP is single-use.
 *   AUTH-039           — Resend OTP is rate-limited (see ThrottlerModule + otp.maxAttempts).
 *   Part 7 §2          — Changing password may invalidate existing sessions (configurable).
 */
export default registerAs('auth', () => ({
  otp: {
    // OTP validity in seconds (AUTH-038). Default 10 minutes.
    ttlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? '600', 10),
    // Number of digits in the OTP code.
    length: parseInt(process.env.OTP_LENGTH ?? '6', 10),
    // Max verify attempts before an OTP is locked out (anti-bruteforce, SEC-004).
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5', 10),
  },
  // SRS Part 7 §2: changing password invalidates existing sessions. Configurable.
  resetPasswordInvalidatesSessions:
    (process.env.RESET_PASSWORD_INVALIDATES_SESSIONS ?? 'true') !== 'false',
  // SEC-008 / AUTH-016: Mobile OTP is a future feature and must not be callable.
  // Flip to 'true' only when Mobile OTP is fully implemented + DLT-approved.
  mobileOtpEnabled: (process.env.MOBILE_OTP_ENABLED ?? 'false') === 'true',
}));
