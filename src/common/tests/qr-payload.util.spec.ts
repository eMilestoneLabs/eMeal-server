import {
  encodeQrPayload,
  decodeQrPayload,
  isSignedQrPayload,
} from '../utils/qr-payload.util';

describe('qr-payload.util (GRP-012 signed QR)', () => {
  const secret = 'test-secret';
  const payload = {
    o: 'org_1',
    g: 'grp_1',
    t: 'ABC12345',
    e: null as string | null,
  };

  it('round-trips a signed payload', () => {
    const token = encodeQrPayload(payload, secret);
    expect(isSignedQrPayload(token)).toBe(true);
    expect(decodeQrPayload(token, secret)).toEqual(payload);
  });

  it('rejects a tampered payload body', () => {
    const token = encodeQrPayload(payload, secret);
    const [prefix, body, sig] = token.split('.');
    // Flip a character in the body — signature no longer matches.
    const tamperedBody = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
    expect(decodeQrPayload(`${prefix}.${tamperedBody}.${sig}`, secret)).toBeNull();
  });

  it('rejects a payload signed with a different secret', () => {
    const token = encodeQrPayload(payload, secret);
    expect(decodeQrPayload(token, 'other-secret')).toBeNull();
  });

  it('treats a raw join code as not-a-signed-payload', () => {
    expect(isSignedQrPayload('ABC12345')).toBe(false);
    expect(decodeQrPayload('ABC12345', secret)).toBeNull();
  });
});
