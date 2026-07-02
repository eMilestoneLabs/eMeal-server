import { Injectable, Logger } from '@nestjs/common';
import { GroupsService } from '../groups/groups.service';
import { MealsService } from '../meals/meals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { QueryGroupsDto } from '../groups/dto/query-groups.dto';
import {
  QueryAttendanceDto,
  QueryMealSummaryDto,
} from '../attendance/dto/query-attendance.dto';

/** One item of a paginated service response (serialized, shape-owned by the source service). */
type PaginatedResult = { data: Array<Record<string, any>> } & Record<string, any>;

/**
 * OverviewService — single-round-trip aggregate for the admin dashboard.
 *
 * The Flutter admin dashboard previously issued 1 + 2N + M requests on a cold
 * load (groups → today's meals per group + history per group → meal-summary
 * per meal): three sequential network waves over a high-RTT link. This service
 * runs the SAME underlying service calls server-side (loopback, ~ms each) and
 * returns everything in one response, so the client pays one round-trip.
 *
 * Design rules:
 *   • Zero duplicated business logic — composes the existing GroupsService /
 *     MealsService / AttendanceService methods, so every element of the
 *     response is byte-identical to what the individual endpoints return
 *     (tenant isolation, role checks, planner overlay, Redis caching and
 *     invalidation all inherited from the source services).
 *   • No extra response-level cache — per-meal summaries are already Redis-
 *     cached (and invalidated on attendance writes) inside AttendanceService;
 *     caching the composite would only add staleness risk.
 *   • Fail-soft per section — one group/meal failing never fails the whole
 *     overview (mirrors the client, which ignored individual wave failures).
 */
@Injectable()
export class OverviewService {
  private readonly logger = new Logger(OverviewService.name);

  constructor(
    private readonly groupsService: GroupsService,
    private readonly mealsService: MealsService,
    private readonly attendanceService: AttendanceService,
  ) {}

  async getAdminOverview(
    userId: string,
    role: string,
    organizationId: string,
    date?: string,
  ) {
    // Same date semantics as the legacy client calls: phone-local date when
    // provided, otherwise the server's UTC date.
    const day = date ?? new Date().toISOString().slice(0, 10);

    // Wave 1 (server-side): groups — identical to GET /groups?page=1&limit=100.
    const groupsPage = (await this.groupsService.getGroups(
      userId,
      role,
      organizationId,
      { page: 1, limit: 100 } as QueryGroupsDto,
    )) as PaginatedResult;
    const groups = groupsPage.data ?? [];

    // Wave 2 (server-side, parallel): today's meals per group + last-5 history
    // per group — identical to GET /meals/today and GET /attendance/history.
    const [mealResults, historyResults] = await Promise.all([
      Promise.allSettled(
        groups.map((g) =>
          this.mealsService.getTodayMeals(userId, role, organizationId, g.id),
        ),
      ),
      Promise.allSettled(
        groups.map((g) =>
          this.attendanceService.getAttendance(userId, role, organizationId, {
            groupId: g.id,
            fromDate: day,
            toDate: day,
            page: 1,
            limit: 5,
          } as QueryAttendanceDto),
        ),
      ),
    ]);

    // Union of today's meals, de-duplicated by id (mirrors the client merge).
    const seenMealIds = new Set<string>();
    const todayMeals: Array<Record<string, any>> = [];
    for (const r of mealResults) {
      if (r.status !== 'fulfilled') continue;
      for (const meal of (r.value as PaginatedResult).data ?? []) {
        if (meal?.id && seenMealIds.add(meal.id)) todayMeals.push(meal);
      }
    }

    // Wave 3 (server-side, parallel): per-meal summary — identical to
    // GET /attendance/meal-summary (each hit is Redis-cached upstream).
    const summaryResults = await Promise.allSettled(
      todayMeals.map((m) =>
        this.attendanceService.getMealSummary(organizationId, {
          mealId: m.id,
          date: day,
        } as QueryMealSummaryDto),
      ),
    );
    const mealSummaries = summaryResults
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<Record<string, any>>).value);

    // Raw union of per-group history pages; the client applies its existing
    // filter/sort/take-5 logic, so behavior stays identical to the legacy path.
    const recentActivity: Array<Record<string, any>> = [];
    for (const r of historyResults) {
      if (r.status !== 'fulfilled') continue;
      recentActivity.push(...((r.value as PaginatedResult).data ?? []));
    }

    return {
      groups: groupsPage,
      todayMeals,
      mealSummaries,
      recentActivity,
      date: day,
      generatedAt: new Date().toISOString(),
    };
  }
}
