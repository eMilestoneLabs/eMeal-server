/**
 * auth.contract.spec.ts — Auth feature validation contract (B1).
 *
 * Locks the login + admin signup DTO rules under the same pipe config as
 * production (whitelist + forbidNonWhitelisted). Pure unit — class-validator
 * only, no DB/Nest bootstrap.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import { LoginDto } from '../dto/login.dto';
import { AdminSignupDto } from '../dto/signup.dto';

const PIPE: ValidatorOptions = { whitelist: true, forbidNonWhitelisted: true };

async function check(dto: any, raw: object) {
  return validate(plainToInstance(dto, raw) as object, PIPE);
}

describe('Auth · login contract', () => {
  it('accepts identifier + password', async () => {
    expect(await check(LoginDto, { identifier: 'a@b.com', password: 'password123' })).toHaveLength(0);
  });

  it('rejects a missing identifier', async () => {
    const errs = await check(LoginDto, { password: 'password123' });
    expect(errs.some((e) => e.property === 'identifier')).toBe(true);
  });

  it('rejects a too-short password', async () => {
    const errs = await check(LoginDto, { identifier: 'a@b.com', password: 'short' });
    expect(errs.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects unknown fields (forbidNonWhitelisted)', async () => {
    const errs = await check(LoginDto, { identifier: 'a@b.com', password: 'password123', injected: 1 });
    expect(errs.some((e) => e.property === 'injected')).toBe(true);
  });
});

describe('Auth · admin signup contract', () => {
  const valid = {
    name: 'Org Admin',
    role: 'organizationManager',
    email: 'admin@org.com',
    password: 'password123',
    organizationName: 'Acme Mess',
  };

  it('accepts a valid admin signup', async () => {
    expect(await check(AdminSignupDto, valid)).toHaveLength(0);
  });

  it('rejects an invalid role', async () => {
    const errs = await check(AdminSignupDto, { ...valid, role: 'superuser' });
    expect(errs.some((e) => e.property === 'role')).toBe(true);
  });

  it('rejects a missing password', async () => {
    const { password, ...noPass } = valid;
    const errs = await check(AdminSignupDto, noPass);
    expect(errs.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects a client-supplied organizationId (JWT-only field)', async () => {
    const errs = await check(AdminSignupDto, { ...valid, organizationId: 'org_hack' });
    expect(errs.some((e) => e.property === 'organizationId')).toBe(true);
  });
});
