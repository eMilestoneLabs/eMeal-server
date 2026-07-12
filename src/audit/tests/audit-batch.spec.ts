/**
 * audit-batch.spec.ts — micro-batched audit writes (million-user scale).
 *
 * Verifies:
 *  • rows are buffered and flushed with ONE createMany (threshold flush);
 *  • the timer flush drains the buffer without reaching the threshold;
 *  • a createMany failure degrades to per-row inserts (no silent batch loss);
 *  • onModuleDestroy drains the buffer (PM2 reload safety);
 *  • AUDIT_FLUSH_INTERVAL_MS=0 keeps the legacy per-row path.
 */

import { AuditService } from '../audit.service';

function makePrisma() {
  return {
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as any;
}

const dto = (i: number) => ({
  organizationId: 'org1',
  actorId: `user${i}`,
  targetId: `t${i}`,
  targetType: 'User',
  action: 'update' as any,
});

describe('AuditService — micro-batched writes', () => {
  const OLD_FLUSH = process.env.AUDIT_FLUSH_INTERVAL_MS;
  const OLD_MAX = process.env.AUDIT_BUFFER_MAX;

  afterEach(() => {
    if (OLD_FLUSH === undefined) delete process.env.AUDIT_FLUSH_INTERVAL_MS;
    else process.env.AUDIT_FLUSH_INTERVAL_MS = OLD_FLUSH;
    if (OLD_MAX === undefined) delete process.env.AUDIT_BUFFER_MAX;
    else process.env.AUDIT_BUFFER_MAX = OLD_MAX;
    jest.useRealTimers();
  });

  it('flushes once via createMany when the buffer threshold is hit', async () => {
    process.env.AUDIT_FLUSH_INTERVAL_MS = '60000';
    process.env.AUDIT_BUFFER_MAX = '3';
    const prisma = makePrisma();
    const svc = new AuditService(prisma);

    await svc.log(dto(1));
    await svc.log(dto(2));
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();

    await svc.log(dto(3)); // threshold → immediate flush
    await new Promise((r) => setImmediate(r));

    expect(prisma.auditLog.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.createMany.mock.calls[0][0].data).toHaveLength(3);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('timer flush drains the buffer below the threshold', async () => {
    jest.useFakeTimers();
    process.env.AUDIT_FLUSH_INTERVAL_MS = '1000';
    process.env.AUDIT_BUFFER_MAX = '200';
    const prisma = makePrisma();
    const svc = new AuditService(prisma);

    await svc.log(dto(1));
    await svc.log(dto(2));
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1100);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));

    expect(prisma.auditLog.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('degrades to per-row inserts when the batched INSERT fails', async () => {
    process.env.AUDIT_FLUSH_INTERVAL_MS = '60000';
    process.env.AUDIT_BUFFER_MAX = '2';
    const prisma = makePrisma();
    prisma.auditLog.createMany.mockRejectedValueOnce(new Error('boom'));
    const svc = new AuditService(prisma);

    await svc.log(dto(1));
    await svc.log(dto(2)); // threshold flush → createMany fails → fallback
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy drains buffered rows (graceful shutdown)', async () => {
    process.env.AUDIT_FLUSH_INTERVAL_MS = '60000';
    process.env.AUDIT_BUFFER_MAX = '200';
    const prisma = makePrisma();
    const svc = new AuditService(prisma);

    await svc.log(dto(1));
    await svc.onModuleDestroy();

    expect(prisma.auditLog.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('AUDIT_FLUSH_INTERVAL_MS=0 preserves the legacy per-row path', async () => {
    process.env.AUDIT_FLUSH_INTERVAL_MS = '0';
    const prisma = makePrisma();
    const svc = new AuditService(prisma);

    await svc.log(dto(1));
    await new Promise((r) => setImmediate(r));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });
});
