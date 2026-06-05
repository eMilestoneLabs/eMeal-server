/**
 * dto-whitelist.spec.ts — Security regression: DTO validation governance.
 *
 * The global ValidationPipe runs with { whitelist: true, forbidNonWhitelisted: true }.
 * These tests lock that behaviour at the DTO level so a regression (e.g. a removed
 * decorator, or accepting an unknown field such as a client-supplied organizationId)
 * fails CI before it can reach production.
 *
 * Pure unit test — exercises class-validator/class-transformer directly, no DB/Nest.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import { CreateGroupDto } from '../../features/groups/dto/create-group.dto';

// Mirrors the global pipe configuration in main.ts.
const PIPE_OPTS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

async function runPipe(dto: any, raw: object) {
  const instance = plainToInstance(dto, raw);
  const errors = await validate(instance as object, PIPE_OPTS);
  return { instance, errors };
}

describe('DTO validation governance (whitelist + forbidNonWhitelisted)', () => {
  it('accepts a valid CreateGroupDto', async () => {
    const { errors } = await runPipe(CreateGroupDto, {
      name: 'Block A Mess',
      type: 'mess',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown field (forbidNonWhitelisted)', async () => {
    const { errors } = await runPipe(CreateGroupDto, {
      name: 'Block A Mess',
      type: 'mess',
      hackerField: 'inject',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'hackerField')).toBe(true);
  });

  it('rejects a client-supplied organizationId (multi-tenant safety)', async () => {
    // organizationId must come from the JWT, never the request body.
    const { errors } = await runPipe(CreateGroupDto, {
      name: 'Block A Mess',
      type: 'mess',
      organizationId: 'org_attacker',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'organizationId')).toBe(true);
  });

  it('rejects an invalid group type (enum allow-list)', async () => {
    const { errors } = await runPipe(CreateGroupDto, {
      name: 'Block A Mess',
      type: 'not-a-real-type',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'type')).toBe(true);
  });

  it('rejects a missing required name', async () => {
    const { errors } = await runPipe(CreateGroupDto, { type: 'mess' });
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a wrong-typed maxMembers', async () => {
    const { errors } = await runPipe(CreateGroupDto, {
      name: 'Block A Mess',
      type: 'mess',
      maxMembers: 'lots',
    });
    expect(errors.some((e) => e.property === 'maxMembers')).toBe(true);
  });
});
