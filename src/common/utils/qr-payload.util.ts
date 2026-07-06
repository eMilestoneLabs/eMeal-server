import { createHmac, timingSafeEqual } from 'crypto';

/**
 * GRP-012 — signed QR invitation payload.
 *
 * The QR encodes Organization ID, Group ID, the Join Code (token) and an Expiry,
 * protected by an HMAC-SHA256 signature so a tampered or forged QR is rejected
 * server-side. Format (compact, URL-safe, no external deps):
 *
 *   emg1.<base64url(payloadJSON)>.<base64url(hmac)>
 *
 * Backward compatible: the raw Join Code is still accepted by the join endpoint,
 * so old QR images and manual code entry keep working.
 */

export const QR_PREFIX = 'emg1';

export interface QrPayload {
  /** organizationId */
  o: string;
  /** groupId */
  g: string;
  /** join token (== joinCode) */
  t: string;
  /** expiry ISO string, or null = never */
  e: string | null;
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

/** Build the signed QR payload string for a group invitation. */
export function encodeQrPayload(payload: QrPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${QR_PREFIX}.${body}.${sign(body, secret)}`;
}

/** True if a scanned value looks like a signed QR payload (vs a raw code). */
export function isSignedQrPayload(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${QR_PREFIX}.`);
}

/**
 * Verify + decode a signed QR payload. Returns null when the value is not a
 * signed payload, the signature is invalid/tampered, or it is malformed.
 * Expiry is NOT enforced here (the caller decides how to treat expiry) — but
 * `e` is returned so the caller can check it.
 */
export function decodeQrPayload(
  value: string,
  secret: string,
): QrPayload | null {
  if (!isSignedQrPayload(value)) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [, body, providedSig] = parts;

  const expectedSig = sign(body, secret);
  const a = Buffer.from(expectedSig);
  const b = Buffer.from(providedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as QrPayload;
    if (!parsed || typeof parsed.t !== 'string' || !parsed.t) return null;
    return parsed;
  } catch {
    return null;
  }
}
