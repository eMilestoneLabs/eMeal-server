import { Injectable, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { DashboardRepository } from '../repositories/dashboard.repository';
import { RedisService } from '../../../redis/redis.service';
import {
  StudentDashboardSerializer,
  AdminDashboardSerializer,
  AttendanceAnalyticsSerializer,
} from '../serializers/dashboard.serializer';

const ADMIN_ROLES = ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'];

// Cache TTLs (seconds)
const STUDENT_DASHBOARD_TTL = 120;   // 2 minutes — attendance marks invalidate
const ADMIN_DASHBOARD_TTL = 180;     // 3 minutes — admin overview is less volatile
const ANALYTICS_TTL = 300;           // 5 minutes — historical data is stable

// Redis key builders — exact patterns from B5 spec
const KEYS = {
  studentDashboard: (orgId: string, userId: string) =>
    `dashboard:student:${orgId}:${userId}`,
  adminDashboard: (orgId: string) =>
    `dashboard:admin:${orgId}`,
  attendanceAnalytics: (orgId: string, groupId: string) =>
    `analytics:attendance:${orgId}:${groupId}`,
  mealAnalytics: (orgId: string, groupId: string) =>
    `analytics:meal:${orgId}:${groupId}`,
  orgAnalytics: (orgId: string) =>
    `analytics:organization:${orgId}`,
};

/**
 * DashboardService — aggregation + caching for student/admin dashboards.
 *
 * Cache strategy:
 *   - Student dashboard: 2-minute Redis TTL, invalidated on attendance mark.
 *   - Admin dashboard: 3-minute Redis TTL, invalidated on group/meal/attendance change.
 *   - Analytics: 5-minute Redis TTL, invalidated on attendance change.
 *
 * Flutter computes rates — backend returns raw counts only.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly dashboardRepo: DashboardRepository,
    private readonly redis: RedisService,
  ) {}

  // ── STUDENT DASHBOARD ─────────────────────────────────────────────────────

  async getStudentDashboard(userId: string, organizationId: string, role: string) {
    // Students, members, guests, and event guests can access student dashboard
    if (ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException({
        message: 'Use admin dashboard endpoint',
        errors: { role: 'Admin users should use GET /dashboard/admin' },
      });
    }

    const cacheKey = KEYS.studentDashboard(organizationId, userId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug(`Student dashboard cache HIT: ${cacheKey}`);
      return JSON.parse(cached);
    }

    this.logger.debug(`Student dashboard cache MISS: ${cacheKey}`);
    const entity = await this.dashboardRepo.buildStudentDashboard(userId, organizationId);
    const response = StudentDashboardSerializer.toResponse(entity);

    await this.redis.set(cacheKey, JSON.stringify(response), STUDENT_DASHBOARD_TTL);

    return response;
  }

  // ── ADMIN DASHBOARD ───────────────────────────────────────────────────────

  async getAdminDashboard(adminId: string, organizationId: string, role: string) {
    if (!ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: { role: 'Admin dashboard requires manager or admin role' },
      });
    }

    const cacheKey = KEYS.adminDashboard(organizationId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug(`Admin dashboard cache HIT: ${cacheKey}`);
      return JSON.parse(cached);
    }

    this.logger.debug(`Admin dashboard cache MISS: ${cacheKey}`);
    const entity = await this.dashboardRepo.buildAdminDashboard(organizationId);
    const response = AdminDashboardSerializer.toResponse(entity);

    await this.redis.set(cacheKey, JSON.stringify(response), ADMIN_DASHBOARD_TTL);

    return response;
  }

  // ── ATTENDANCE ANALYTICS ──────────────────────────────────────────────────

  async getAttendanceAnalytics(
    organizationId: string,
    role: string,
    groupId: string,
    fromDateStr: string,
    toDateStr: string,
  ) {
    if (!ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: { role: 'Analytics requires manager or admin role' },
      });
    }

    const fromDate = parseLocalDate(fromDateStr);
    const toDate = parseLocalDate(toDateStr);

    if (fromDate > toDate) {
      throw new BadRequestException({
        message: 'Invalid date range',
        errors: { fromDate: 'fromDate must be before toDate' },
      });
    }

    // Limit range to 90 days to prevent expensive queries
    const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 90) {
      throw new BadRequestException({
        message: 'Date range too large',
        errors: { toDate: 'Maximum analytics range is 90 days' },
      });
    }

    const cacheKey = `${KEYS.attendanceAnalytics(organizationId, groupId)}:${fromDateStr}:${toDateStr}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const entity = await this.dashboardRepo.buildAttendanceAnalytics(
      organizationId,
      groupId,
      fromDate,
      toDate,
    );
    const response = AttendanceAnalyticsSerializer.toResponse(entity);

    await this.redis.set(cacheKey, JSON.stringify(response), ANALYTICS_TTL);

    return response;
  }

  // ── CACHE INVALIDATION (called by other services) ─────────────────────────

  /** Invalidate student dashboard cache — called after attendance mark. */
  async invalidateStudentDashboard(userId: string, organizationId: string): Promise<void> {
    await this.redis.del(KEYS.studentDashboard(organizationId, userId)).catch(() => null);
  }

  /** Invalidate admin dashboard cache — called after group/meal/attendance changes. */
  async invalidateAdminDashboard(organizationId: string): Promise<void> {
    await this.redis.del(KEYS.adminDashboard(organizationId)).catch(() => null);
  }

  /**
   * Invalidate attendance analytics — called after attendance changes in a group.
   *
   * FIX: was deleting only the base key. Analytics cache keys include date ranges:
   *   analytics:attendance:{orgId}:{groupId}:{fromDate}:{toDate}
   * Deleting just the base key left all date-range variants stale indefinitely.
   * Now uses SCAN-based pattern deletion to sweep all date-range variants.
   */
  async invalidateAttendanceAnalytics(organizationId: string, groupId: string): Promise<void> {
    const pattern = `${KEYS.attendanceAnalytics(organizationId, groupId)}*`;
    const deleted = await this.redis.deletePattern(pattern).catch(() => 0);
    if (deleted > 0) {
      this.logger.debug(`Invalidated ${deleted} analytics cache keys for group=${groupId}`);
    }
  }
}

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
