import { generateJoinCode } from '../utils/code.utils';

describe('code.utils · generateJoinCode', () => {
  it('defaults to 8 uppercase alphanumeric characters', () => {
    const code = generateJoinCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('respects a custom length', () => {
    expect(generateJoinCode(6)).toMatch(/^[A-Z0-9]{6}$/);
    expect(generateJoinCode(12)).toHaveLength(12);
  });

  it('only ever emits the allowed charset across many samples', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateJoinCode()).toMatch(/^[A-Z0-9]{8}$/);
    }
  });

  it('produces varied codes (not a constant)', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateJoinCode()));
    expect(set.size).toBeGreaterThan(1);
  });
});
