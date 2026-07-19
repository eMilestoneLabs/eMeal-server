import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OverviewService } from '../features/overview/overview.service';
import { DashboardService } from '../features/dashboard/services/dashboard.service';
import { NoticesService } from '../features/notices/notices.service';
import { UsersService } from '../features/users/users.service';

/**
 * Boot warmup — kills the post-reload cold-start latency spike.
 *
 * After every PM2 reload the first benchmark pass showed p95s far above the
 * golden bands (/dashboard/admin/overview 465ms vs the warm 135ms) because
 * each fresh worker pays one-time costs on its first real requests: Prisma
 * engine spin-up, pool connection establishment, per-model query compilation
 * and V8 JIT. The deploy script's unauthenticated /health hits cannot warm
 * authenticated query paths — so each worker primes itself here, at
 * bootstrap, before real traffic lands on it.
 *
 * DEEP WARMUP (2026-07-19): the findFirst-per-model pass warms the engine but
 * NOT the real endpoint query SHAPES or the V8 paths of the services — so
 * with PM2 round-robin each of the 4 workers still paid its own first-hit
 * cost per endpoint (audit evidence: p95/max inflated on 2-minute-old
 * workers while minimums stayed 5-30ms golden, a different endpoint set slow
 * each run). Now each worker also executes the HOT SERVICE METHODS themselves
 * (read-only, on a sampled org/admin/student) — overview (which fans out to
 * groups + meals/today + attendance history + meal summaries), both
 * dashboards (also PRE-FILLING their Redis caches for every worker), the
 * notices feed and /users/me. First real request after a deploy now lands on
 * a fully warmed worker. WARMUP_DEEP=0 disables just the deep pass.
 *
 * Fire-and-forget: warmup must never delay or block startup, and a failure
 * (e.g. DB briefly unavailable during boot, or an empty fresh install with no
 * accounts yet) is logged and ignored — the health check governs readiness,
 * not this. Strictly read-only: no writes, no audit rows, no notifications.
 *
 * WARMUP_ON_BOOT=0 disables (default on).
 */
@Injectable()
export class WarmupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WarmupService.name);
  private readonly enabled = (process.env.WARMUP_ON_BOOT ?? '1') !== '0';
  private readonly deepEnabled = (process.env.WARMUP_DEEP ?? '1') !== '0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly redis?: RedisService | null,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Boot warmup disabled (WARMUP_ON_BOOT=0)');
      return;
    }
    void this.run().catch((err: Error) => {
      this.logger.warn(`Boot warmup skipped: ${err.message}`);
    });
  }

  private async run(): Promise<void> {
    const t0 = Date.now();

    // Connection + engine handshake first, then the hot read models touched
    // by the dashboard/attendance/billing/notices surfaces in parallel. Each
    // is a cheapest-possible indexed read — the value is the one-time
    // per-model compile + pooled connections, not the data.
    await this.prisma.$queryRaw`SELECT 1`;
    await Promise.all([
      this.prisma.user.findFirst({ select: { id: true } }),
      this.prisma.group.findFirst({ select: { id: true } }),
      this.prisma.groupMember.findFirst({ select: { id: true } }),
      this.prisma.meal.findFirst({ select: { id: true } }),
      this.prisma.attendanceRecord.findFirst({ select: { id: true } }),
      this.prisma.mealSchedule.findFirst({ select: { id: true } }),
      this.prisma.notice.findFirst({ select: { id: true } }),
      this.prisma.vacationRequest.findFirst({ select: { id: true } }),
      this.prisma.refreshToken.findFirst({ select: { id: true } }),
      this.redis?.ping().catch(() => false) ?? Promise.resolve(false),
    ]);

    const primed = this.deepEnabled ? await this.deepWarm() : 0;
    this.logger.log(
      `Boot warmup completed in ${Date.now() - t0}ms` +
        (this.deepEnabled ? ` (deep paths primed: ${primed})` : ''),
    );
  }

  /**
   * Executes the real hot endpoint paths once on THIS worker (read-only).
   * Every step is individually fail-soft; returns how many paths primed.
   */
  private async deepWarm(): Promise<number> {
    // Sample one admin and one grouped student — real tenants, read-only use.
    const [admin, student] = await Promise.all([
      this.prisma.user.findFirst({
        where: {
          organizationId: { not: null },
          NOT: { role: 'student' },
          deletedAt: null,
        },
        select: { id: true, role: true, organizationId: true },
      }),
      this.prisma.user.findFirst({
        where: {
          role: 'student',
          organizationId: { not: null },
          deletedAt: null,
          groupMembers: { some: { status: 'active' } },
        },
        select: { id: true, role: true, organizationId: true },
      }),
    ]);

    const tasks: Array<Promise<unknown>> = [];
    const resolve = <T>(token: new (...args: never[]) => T): T | null => {
      try {
        return this.moduleRef.get(token, { strict: false });
      } catch {
        return null;
      }
    };

    if (admin?.organizationId) {
      const overview = resolve(OverviewService);
      const dashboard = resolve(DashboardService);
      const notices = resolve(NoticesService);
      if (overview) {
        // One call warms the whole admin surface: groups list, per-group
        // meals/today, attendance history and per-meal summaries.
        tasks.push(
          overview.getAdminOverview(admin.id, admin.role, admin.organizationId),
        );
      }
      if (dashboard) {
        tasks.push(
          dashboard.getAdminDashboard(admin.id, admin.organizationId, admin.role),
        );
      }
      if (notices) {
        tasks.push(
          notices.listNotices(admin.id, admin.role, admin.organizationId, {
            page: 1,
            limit: 20,
          } as never),
        );
      }
    }

    if (student?.organizationId) {
      const dashboard = resolve(DashboardService);
      const users = resolve(UsersService);
      if (dashboard) {
        tasks.push(
          dashboard.getStudentDashboard(
            student.id,
            student.organizationId,
            student.role,
          ),
        );
      }
      if (users) tasks.push(users.getMe(student.id));
    }

    if (tasks.length === 0) return 0; // fresh install — nothing to warm yet
    const results = await Promise.allSettled(tasks);
    return results.filter((r) => r.status === 'fulfilled').length;
  }
}
