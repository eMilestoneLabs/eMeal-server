import { GuestCountValidator } from '../validators/guest-count.validator';
import { JoinCodeValidator } from '../validators/join-code.validator';

const argsWith = (object: any): any => ({ object });

describe('GuestCountValidator', () => {
  const v = new GuestCountValidator();

  it('accepts a normal party (adults + children within range)', () => {
    expect(v.validate(0, argsWith({ adultsCount: 2, childrenCount: 1 }))).toBe(true);
  });
  it('defaults to 1 adult / 0 children when counts are absent', () => {
    expect(v.validate(0, argsWith({}))).toBe(true);
  });
  it('rejects an empty party (total 0)', () => {
    expect(v.validate(0, argsWith({ adultsCount: 0, childrenCount: 0 }))).toBe(false);
  });
  it('rejects a party larger than the max size (50)', () => {
    expect(v.validate(0, argsWith({ adultsCount: 50, childrenCount: 1 }))).toBe(false);
  });
  it('accepts exactly the max size', () => {
    expect(v.validate(0, argsWith({ adultsCount: 50, childrenCount: 0 }))).toBe(true);
  });
  it('exposes a default error message', () => {
    expect(v.defaultMessage(argsWith({}))).toContain('between 1 and 50');
  });
});

describe('JoinCodeValidator', () => {
  const v = new JoinCodeValidator();

  it('accepts an 8-char alphanumeric code', () => {
    expect(v.validate('ABC123XZ', {} as any)).toBe(true);
  });
  it('accepts hyphens and underscores', () => {
    expect(v.validate('join-token_01', {} as any)).toBe(true);
  });
  it('rejects too-short codes', () => {
    expect(v.validate('abc', {} as any)).toBe(false);
  });
  it('rejects codes with spaces or special characters', () => {
    expect(v.validate('has space', {} as any)).toBe(false);
    expect(v.validate('bad$code!', {} as any)).toBe(false);
  });
  it('rejects empty / non-string input', () => {
    expect(v.validate('', {} as any)).toBe(false);
    expect(v.validate(null as any, {} as any)).toBe(false);
  });
  it('accepts a long (64-char) code', () => {
    expect(v.validate('a'.repeat(64), {} as any)).toBe(true);
  });
});
