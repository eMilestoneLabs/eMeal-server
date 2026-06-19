import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import type { RealtimeEventsService } from '../../realtime/services/realtime-events.service';
import { MealsRepository } from './repositories/meals.repository';
import { SchedulesRepository } from './repositories/schedules.repository';
import {
  MealSerializer,
  GENERAL_ATTENDANCE_SLOT_KEY,
} from './serializers/meal.serializer';
import { AuditService } from '../../audit/audit.service';
import { CreateMealDto } from './dto/create-meal.dto';
import { UpdateMealDto, ReorderMealsDto } from './dto/update-meal.dto';
import { QueryMealsDto } from './dto/query-meals.dto';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { GroupsRepository } from '../groups/repositories/groups.repository';

/**
 * MealsService — business logic for meal CRUD and ordering.
 *
 * Architecture:
 *   Controller → Service → Repository → Prisma → Serializer → Response
 *
 * Key rules:
 * - Admin: sees all meals (including disabled) for their org groups.
 * - Student: sees only isActive=true meals for their groups.
 * - Org isolation: groupId must belong to organizationId from JWT.
 * - slotKey: always free-form — never validated against an enum.
 * - attendanceEnabled is independent of isActive (isEnabled).
 */
@Injectable()
export class MealsService {
  private readonly logger = new Logger(MealsService.name);

  constructor(
    private readonly mealsRepo: MealsRepository,
    private readonly groupsRepo: GroupsRepository,
    private readonly schedulesRepo: SchedulesRepository,
    private readonly audit: AuditService,
    @Optional() @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
  ) {}

  // ── CREATE ────────────────────────────────────────────────────────────────

  async createMeal(
    adminId: string,
    organizationId: string,
    dto: CreateMealDto,
    requestId?: string,
  ) {
    // Verify the target group belongs to this organization
    const group = await this.groupsRepo.findById(dto.groupId, organizationId);
    if (!group) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    // Verify mealsEnabled on group config
    if (!group.mealsEnabled) {
      throw new BadRequestException({
        message: 'Meals are disabled for this group',
        errors: { groupId: 'Enable meals in group settings before adding meal slots' },
      });
    }

    const meal = await this.mealsRepo.create({
      organizationId,
      groupId: dto.groupId,
      slotKey: dto.slotKey,
      name: dto.name,
      displayName: dto.displayName ?? null,
      order: dto.order ?? 0,
      attendanceEnabled: dto.attendanceEnabled ?? true,
      description: dto.description ?? null,
      menuItems: dto.menuItems ?? [],
      imageUrl: dto.imageUrl ?? null,
      preferencesEnabled: dto.preferencesEnabled ?? false,
      enabledPreferences: dto.enabledPreferences ?? [],
      attendanceWindowOpen: dto.attendanceWindow?.openTime ?? null,
      attendanceWindowClose: dto.attendanceWindow?.closeTime ?? null,
    });

    // Fire-and-forget audit log
    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: meal.id,
      targetType: 'Meal',
      action: 'create',
      metadata: { slotKey: meal.slotKey, groupId: meal.groupId },
      requestId,
    });

    this.logger.log(`Meal created: \${meal.id} slotKey=\${meal.slotKey} group=\${meal.groupId}`);

    // B7: emit meal.updated.v1 so clients invalidate their meal cache
    this.realtime?.emitMealUpdated(organizationId, {
      organizationId,
      groupId: meal.groupId,
      mealId: meal.id,
      isActive: meal.isActive,
      slotKey: meal.slotKey,
    });

    return MealSerializer.toResponse(meal);
  }

  // ── LIST ──────────────────────────────────────────────────────────────────

  async getMeals(
    userId: string,
    role: string,
    organizationId: string,
    query: QueryMealsDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const isAdmin = ADMIN_ROLES.includes(role as any);

    if (!query.groupId) {
      throw new BadRequestException({
        message: 'groupId is required',
        errors: { groupId: 'Provide a groupId query parameter' },
      });
    }

    // Verify the group belongs to this org (tenant isolation)
    const group = await this.groupsRepo.findById(query.groupId, organizationId);
    if (!group) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    const result = await this.mealsRepo.findByGroup(query.groupId, organizationId, {
      page,
      limit,
      slotKey: query.slotKey,
      // Students only see enabled meals; admin can request disabled via query param
      includeDisabled: isAdmin && !!query.includeDisabled,
    });

    // #9/#10: never surface the implicit general-attendance slot as a normal
    // meal (it is only returned by getTodayMeals as a day-level mark card).
    const visible = result.data.filter(
      (m) => m.slotKey !== GENERAL_ATTENDANCE_SLOT_KEY,
    );
    const removed = result.data.length - visible.length;

    return PaginatedResponseDto.of(
      MealSerializer.toList(visible),
      Math.max(0, result.total - removed),
      result.page,
      result.limit,
    );
  }

  // ── TODAY (with attendance-only fallback) ──────────────────────────────────

  /**
   * Today's meals for a group (#9/#10).
   * - Active meals configured        -> return them (meal-based attendance).
   * - mealsEnabled == false (no meal
   *   system)                        -> return the implicit "general attendance"
   *                                     slot so attendance-only groups work.
   * - mealsEnabled == true but NONE
   *   configured                     -> return EMPTY. The admin must configure at
   *                                     least one meal; the client shows
   *                                     "No meal has been configured ... Attendance
   *                                     is not allowed." (attendance stays blocked).
   */
  async getTodayMeals(
    userId: string,
    role: string,
    organizationId: string,
    groupId: string,
  ) {
    const result = await this.getMeals(userId, role, organizationId, {
      groupId,
      page: 1,
      limit: 50,
    } as QueryMealsDto);

    if (result.data.length > 0) {
      // Additive: overlay the active planner schedule (Weekly / Day-Wise Meal
      // Mode) onto today's meals so per-day attendance window, preference
      // enforcement and meal visibility follow admin configuration. Attendance,
      // analytics, history and notifications stay unchanged (same mealId/date).
      const planGroup = await this.groupsRepo.findById(groupId, organizationId);
      if (
        planGroup &&
        (planGroup.weeklyMenuEnabled || planGroup.dayWiseMealsEnabled)
      ) {
        const overlay = await this.schedulesRepo.findTodayOverlay(
          groupId,
          organizationId,
        );
        if (overlay.size > 0) {
          const overlaid = result.data
            .filter((m: any) => overlay.has(m.id))
            .map((m: any) => {
              const o = overlay.get(m.id)!;
              const next: any = { ...m };
              if (o.openTime) {
                next.attendanceWindow = {
                  openTime: o.openTime,
                  closeTime: o.closeTime ?? null,
                };
              }
              if (o.preferencesEnabled !== null) {
                next.preferencesEnabled = o.preferencesEnabled;
                if (o.enabledPreferences.length > 0) {
                  next.enabledPreferences = o.enabledPreferences;
                }
              }
              // Issue 3: per-day menu shown on the meal card + detail screen.
              if (o.menuItems && o.menuItems.length > 0) {
                next.menuItems = o.menuItems;
              }
              return next;
            });
          if (overlaid.length > 0) {
            return PaginatedResponseDto.of(overlaid, overlaid.length, 1, 50);
          }
        }
      }
      return result;
    }

    // No active meals. Only provide the implicit attendance slot when the meal
    // system is DISABLED for this group (true attendance-only mode). When meals
    // are ENABLED but none configured, attendance is intentionally blocked.
    const group = await this.groupsRepo.findById(groupId, organizationId);
    if (group && group.mealsEnabled === false) {
      const slot = await this.ensureGeneralSlot(groupId, organizationId);
      return PaginatedResponseDto.of(
        [MealSerializer.toResponse(slot)],
        1,
        1,
        50,
      );
    }

    return PaginatedResponseDto.of([], 0, 1, 50);
  }

  /**
   * Find-or-create the implicit per-group general-attendance slot (#9/#10).
   * Idempotent; bypasses the mealsEnabled guard on purpose so attendance works
   * for attendance-only groups. Hidden from normal meal lists by slotKey.
   */
  async ensureGeneralSlot(groupId: string, organizationId: string) {
    const existing = await this.mealsRepo.findByGroup(groupId, organizationId, {
      page: 1,
      limit: 1,
      slotKey: GENERAL_ATTENDANCE_SLOT_KEY,
      includeDisabled: true,
    });
    if (existing.data.length > 0) return existing.data[0];

    return this.mealsRepo.create({
      organizationId,
      groupId,
      slotKey: GENERAL_ATTENDANCE_SLOT_KEY,
      name: 'Attendance',
      displayName: 'Daily Attendance',
      order: 0,
      attendanceEnabled: true,
      description: null,
      menuItems: [],
      imageUrl: null,
      preferencesEnabled: false,
      enabledPreferences: [],
      attendanceWindowOpen: null,
      attendanceWindowClose: null,
    });
  }

  // ── GET ONE ───────────────────────────────────────────────────────────────

  async getMealById(
    id: string,
    organizationId: string,
    role: string,
    includeDisabled = false,
  ) {
    const isAdmin = ADMIN_ROLES.includes(role as any);
    const meal = await this.mealsRepo.findById(id, organizationId, isAdmin && includeDisabled);
    if (!meal) {
      throw new NotFoundException({
        message: 'Meal not found',
        errors: { id: 'Meal does not exist or has been archived' },
      });
    }
    return MealSerializer.toResponse(meal);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────

  async updateMeal(
    id: string,
    organizationId: string,
    adminId: string,
    dto: UpdateMealDto,
    requestId?: string,
  ) {
    // Ensure meal exists in this org
    const existing = await this.mealsRepo.findById(id, organizationId, true);
    if (!existing) {
      throw new NotFoundException({
        message: 'Meal not found',
        errors: { id: 'Meal does not exist in your organization' },
      });
    }

    // Build update payload — only include explicitly provided fields
    const updateData: Parameters<typeof this.mealsRepo.update>[2] = {};

    if (dto.slotKey !== undefined)   updateData.slotKey = dto.slotKey;
    if (dto.name !== undefined)       updateData.name = dto.name;
    if ('displayName' in dto)         updateData.displayName = dto.displayName ?? null;
    if (dto.order !== undefined)      updateData.order = dto.order;
    if (dto.isEnabled !== undefined)  updateData.isActive = dto.isEnabled; // isEnabled → isActive
    if (dto.attendanceEnabled !== undefined) updateData.attendanceEnabled = dto.attendanceEnabled;
    if ('description' in dto)         updateData.description = dto.description ?? null;
    if (dto.menuItems !== undefined)  updateData.menuItems = dto.menuItems;
    if ('imageUrl' in dto)            updateData.imageUrl = dto.imageUrl ?? null;
    if (dto.preferencesEnabled !== undefined) updateData.preferencesEnabled = dto.preferencesEnabled;
    if (dto.enabledPreferences !== undefined) updateData.enabledPreferences = dto.enabledPreferences;

    // Handle attendanceWindow — null clears the window; object updates both fields
    if ('attendanceWindow' in dto) {
      if (dto.attendanceWindow === null) {
        updateData.attendanceWindowOpen = null;
        updateData.attendanceWindowClose = null;
      } else if (dto.attendanceWindow) {
        updateData.attendanceWindowOpen = dto.attendanceWindow.openTime;
        updateData.attendanceWindowClose = dto.attendanceWindow.closeTime;
      }
    }

    const updated = await this.mealsRepo.update(id, organizationId, updateData);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'Meal',
      action: 'update',
      metadata: { changes: Object.keys(updateData) },
      requestId,
    });

    // B7: emit meal.updated.v1 on config change
    this.realtime?.emitMealUpdated(organizationId, {
      organizationId,
      groupId: updated.groupId,
      mealId: updated.id,
      isActive: updated.isActive,
      slotKey: updated.slotKey,
    });

    return MealSerializer.toResponse(updated);
  }

  // ── DELETE (soft) ─────────────────────────────────────────────────────────

  async deleteMeal(
    id: string,
    organizationId: string,
    adminId: string,
    requestId?: string,
  ) {
    await this.mealsRepo.softDelete(id, organizationId);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'Meal',
      action: 'delete',
      metadata: { soft: true },
      requestId,
    });

    return { message: 'Meal archived successfully' };
  }

  // ── REORDER ───────────────────────────────────────────────────────────────

  /**
   * Reorder meals for a group.
   * Accepts an ordered array of meal IDs → assigns order=0,1,2,...
   * Flutter will re-render meals in the new order immediately.
   */
  async reorderMeals(
    organizationId: string,
    adminId: string,
    dto: ReorderMealsDto,
    requestId?: string,
  ) {
    // Verify group belongs to this org
    const group = await this.groupsRepo.findById(dto.groupId, organizationId);
    if (!group) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    if (dto.mealIds.length === 0) {
      throw new BadRequestException({
        message: 'mealIds must not be empty',
        errors: { mealIds: 'Provide at least one meal ID' },
      });
    }

    await this.mealsRepo.reorder(dto.mealIds, organizationId);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: dto.groupId,
      targetType: 'Meal',
      action: 'update',
      metadata: { reorder: true, mealIds: dto.mealIds },
      requestId,
    });

    this.logger.log(`Meals reordered for group=${dto.groupId}`);

    return { message: 'Meals reordered successfully', count: dto.mealIds.length };
  }
}
