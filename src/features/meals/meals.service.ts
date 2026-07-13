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
import {
  getCurrentTimeInTimezone,
  getTodayInTimezone,
  getWindowState,
} from '../../common/utils/date.utils';
import { hhmmToMinutes } from './utils/entry-chrono.util';
import { StorageService } from '../../storage/storage.service';
import { PreferencesService } from '../preferences/preferences.service';
import { ConfigService } from '@nestjs/config';

/**
 * Matches a base64 image data URI (jpeg/png) so the meal photo can be uploaded
 * to MinIO and stored as a URL instead of inline base64 — keeping `GET /meals`
 * responses small (performance). Identical pattern to the working avatar flow.
 */
const MEAL_IMAGE_DATA_URI_RE = /^data:(image\/(?:jpeg|png));base64,(.+)$/s;

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
    private readonly storage: StorageService,
    private readonly preferencesService: PreferencesService,
    private readonly config: ConfigService,
    @Optional() @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
  ) {}

  /** SRS MMT-001/MMT-014: configurable Master Meal Template cap (default 10). */
  private get maxMealsPerGroup(): number {
    return this.config.get<number>('meals.maxMealsPerGroup', 10);
  }

  /** SRS Module 03 MODE-003: Master Attendance Template window cap. */
  private get attendanceMaxWindows(): number {
    return this.config.get<number>('meals.attendanceMaxWindows', 5);
  }

  /**
   * SRS Module 03 MODE-003: Attendance-Only Mode has NO meal features — an
   * attendance window carries only name/order/open/close/enabled. Reject any
   * meal-only field so AO groups can never accumulate hidden pricing state.
   */
  private assertAttendanceOnlyFields(dto: {
    price?: number | null;
    preferencesEnabled?: boolean;
    enabledPreferences?: string[];
    menuItems?: string[];
    imageUrl?: string | null;
  }): void {
    const errors: Record<string, string> = {};
    if (dto.price != null) errors.price = 'No meal pricing in Attendance-Only Mode';
    if (dto.preferencesEnabled === true) {
      errors.preferencesEnabled = 'No meal preferences in Attendance-Only Mode';
    }
    if (dto.enabledPreferences?.length) {
      errors.enabledPreferences = 'No meal preferences in Attendance-Only Mode';
    }
    if (dto.menuItems?.length) {
      errors.menuItems = 'No menus in Attendance-Only Mode';
    }
    if (dto.imageUrl) errors.imageUrl = 'No meal images in Attendance-Only Mode';
    if (Object.keys(errors).length > 0) {
      throw new BadRequestException({
        message:
          'Attendance-Only Mode supports attendance windows only — meal pricing, menus, images and preferences are not available.',
        errors,
      });
    }
  }

  /** SRS Module 03 PREF-006.1: max standalone preference tags per meal. */
  private get maxStandaloneTags(): number {
    return this.config.get<number>('preferences.maxStandaloneTags', 5);
  }

  /**
   * SRS Module 03 PREF-006.1 — a meal carries at most maxStandaloneTags
   * standalone preference tags. Enforced on create and update.
   */
  private assertStandaloneTagCap(tags: string[] | undefined): void {
    if (tags && tags.length > this.maxStandaloneTags) {
      throw new BadRequestException({
        message: `A meal supports at most ${this.maxStandaloneTags} standalone preference tags`,
        errors: { enabledPreferences: `Tag limit reached (${this.maxStandaloneTags})` },
      });
    }
  }

  /**
   * Module 36 (FR-PG-090): attach the effective preference groups to serialized
   * meals so the client renders selection UIs dynamically. ONE batched query
   * for the whole list (no N+1). Meals without explicit groups get [] — the
   * client falls back to the legacy flat enabledPreferences UI (FR-PG-021).
   */
  private async attachPreferenceGroups(
    meals: any[],
    organizationId: string,
  ): Promise<void> {
    if (!meals.length) return;
    const map = await this.preferencesService.getEffectiveGroupsForMeals(
      meals.map((m) => m.id),
      organizationId,
    );
    for (const m of meals) m.preferenceGroups = map.get(m.id) ?? [];
  }

  /**
   * Performance fix: when a meal image arrives as a base64 data URI, upload it
   * to MinIO and return the public URL (deleting the previous object on
   * replace). A value that is already a URL, or null/undefined, passes through
   * UNCHANGED — so existing behaviour is preserved; only inline base64 (which
   * bloats every `GET /meals` response) is converted to a small URL. If MinIO is
   * somehow unavailable it falls back to the original value, never hard-failing.
   */
  private async resolveMealImageUrl(
    organizationId: string,
    mealId: string,
    incoming: string | null | undefined,
    previous: string | null,
  ): Promise<string | null | undefined> {
    if (!incoming || !incoming.startsWith('data:image')) return incoming;
    const m = MEAL_IMAGE_DATA_URI_RE.exec(incoming);
    if (!m) return incoming;
    try {
      const mime = m[1] as 'image/jpeg' | 'image/png';
      const buffer = Buffer.from(m[2], 'base64');
      const url = await this.storage.uploadMealImage(
        organizationId,
        mealId,
        buffer,
        mime,
      );
      const prevKey = this.storage.keyFromUrl(previous);
      if (prevKey) await this.storage.deleteImage(prevKey);
      return url;
    } catch {
      return incoming;
    }
  }

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

    // SRS Module 03 MODE-003: Attendance-Only groups use the Master
    // Attendance Template — up to attendanceMaxWindows admin-named windows
    // (name, order, open/close, enabled), auto-applied every day. Windows are
    // stored as window-only meal rows: the whole attendance engine (marking,
    // corrections, sweeps, analytics) is reused with zero duplication, and a
    // future free-tier/subscription gate slots in at this single seam.
    const attendanceOnly = !group.mealsEnabled;
    if (attendanceOnly) {
      this.assertAttendanceOnlyFields(dto);
      if (!dto.attendanceWindow) {
        throw new BadRequestException({
          message: 'An attendance window needs an open and close time',
          errors: { attendanceWindow: 'Provide openTime and closeTime' },
        });
      }
    }

    // SRS Module 03 MMT-001/MMT-014 + MODE-003.2: the Master Meal Template
    // holds at most maxMealsPerGroup active meals (default 10); the Master
    // Attendance Template holds at most attendanceMaxWindows windows
    // (default 5, ATTENDANCE_MAX_WINDOWS). The implicit general-attendance
    // slot never counts against either cap.
    const cap = attendanceOnly ? this.attendanceMaxWindows : this.maxMealsPerGroup;
    const capLabel = attendanceOnly ? 'attendance windows' : 'meals';
    const activeCount = await this.mealsRepo.countActiveInGroup(
      dto.groupId,
      organizationId,
      GENERAL_ATTENDANCE_SLOT_KEY,
    );
    if (activeCount >= cap) {
      throw new BadRequestException({
        message: `A group supports at most ${cap} ${capLabel}`,
        errors: {
          groupId: `Limit reached (${cap}) — disable or delete an existing one first`,
        },
      });
    }

    // SRS Module 03 MMT-003: meal Name is unique per group (case-insensitive).
    if (
      await this.mealsRepo.existsByNameInGroup(
        dto.groupId,
        organizationId,
        dto.name,
      )
    ) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { name: 'A meal with this name already exists in this group' },
      });
    }

    // SRS Module 03 PREF-006.1: standalone tag cap.
    this.assertStandaloneTagCap(dto.enabledPreferences);

    // A base64 data-URI image is uploaded to MinIO AFTER the row exists (the
    // meal id keys the object); store null first, then patch the resolved URL —
    // keeps base64 out of the DB. A plain URL / null passes straight through.
    const imageIsDataUri = !!dto.imageUrl?.startsWith('data:image');

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
      imageUrl: imageIsDataUri ? null : (dto.imageUrl ?? null),
      preferencesEnabled: dto.preferencesEnabled ?? false,
      enabledPreferences: dto.enabledPreferences ?? [],
      attendanceWindowOpen: dto.attendanceWindow?.openTime ?? null,
      attendanceWindowClose: dto.attendanceWindow?.closeTime ?? null,
      price: dto.price ?? null,
    });

    if (imageIsDataUri) {
      const url = await this.resolveMealImageUrl(
        organizationId,
        meal.id,
        dto.imageUrl,
        null,
      );
      if (url) {
        const patched = await this.mealsRepo.update(meal.id, organizationId, {
          imageUrl: url,
        });
        meal.imageUrl = patched.imageUrl;
      }
    }

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

    // Verify the group belongs to this org (tenant isolation).
    // command_6 perf: the meal list query is itself org-scoped, so the 404
    // probe (select id — no member-array payload) runs CONCURRENTLY with it;
    // the gate is still checked before anything is returned.
    const [groupExists, result] = await Promise.all([
      this.groupsRepo.existsInOrg(query.groupId, organizationId),
      this.listGroupMeals(organizationId, query, page, limit, isAdmin),
    ]);
    if (!groupExists) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    return result;
  }

  /**
   * Perf (hot path): the meal listing AFTER tenant verification. getTodayMeals
   * already holds the verified group from its own lookup, so it calls this
   * directly instead of paying getMeals' duplicate groupsRepo.findById —
   * response bytes and semantics are identical to the legacy path.
   */
  private async listGroupMeals(
    organizationId: string,
    query: QueryMealsDto,
    page: number,
    limit: number,
    isAdmin: boolean,
  ) {
    const result = await this.mealsRepo.findByGroup(query.groupId!, organizationId, {
      page,
      limit,
      slotKey: query.slotKey,
      // Students only see enabled meals; admin can request disabled via query param
      includeDisabled: isAdmin && !!query.includeDisabled,
      // command_6 ultra pass: preference bindings ride the same query.
      withPreferenceBindings: true,
    });

    // #9/#10: never surface the implicit general-attendance slot as a normal
    // meal (it is only returned by getTodayMeals as a day-level mark card).
    const visible = result.data.filter(
      (m) => m.slotKey !== GENERAL_ATTENDANCE_SLOT_KEY,
    );
    const removed = result.data.length - visible.length;

    // FR-PG-090 (#1 fix): attach effective preference groups to the serialized
    // list HERE — inside the shared list path — so BOTH the admin planner list
    // (GET /meals, used by the weekly/day-wise editor) AND the student today
    // path carry them. Previously only getTodayMeals attached afterwards, so the
    // admin editor received empty preferenceGroups and could never render the
    // multi-preference groups. Attaching before getTodayMeals' overlay also lets
    // its per-day SUBSET filter actually see the groups. Net query count is
    // unchanged for the today path (the attach moved here from below); the admin
    // list gains one batched, N+1-free lookup.
    const serialized = MealSerializer.toList(visible);
    // command_6 ultra pass: effective preference groups are built in-process
    // from the bindings that rode the meal query itself (was a second DB
    // wave via attachPreferenceGroups). Optional-call keeps existing test
    // doubles working; an absent builder degrades to empty groups exactly
    // like a group with no bindings.
    const prefMap =
      this.preferencesService.buildEffectiveGroupsFromBindings?.(
        (result as any).bindings ?? [],
        organizationId,
      ) ?? new Map();
    for (const m of serialized as any[]) {
      m.preferenceGroups = prefMap.get(m.id) ?? [];
    }

    return PaginatedResponseDto.of(
      serialized,
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
    // command_6 ultra pass: the group row, the meal list (preference
    // bindings riding the same query) and the planner overlay are ALL
    // independent org-scoped reads — ONE parallel wave (was 3 dependent
    // waves). The overlay is an indexed point lookup fetched unconditionally
    // and simply unused when the planner is off; the 404 gate still runs
    // before anything is returned, and tenant isolation holds because every
    // query is org-scoped on its own.
    const isAdmin = ADMIN_ROLES.includes(role as any);
    const [planGroup, result, plannerOverlay] = await Promise.all([
      this.groupsRepo.findById(groupId, organizationId),
      this.listGroupMeals(
        organizationId,
        { groupId, page: 1, limit: 50 } as QueryMealsDto,
        1,
        50,
        isAdmin,
      ),
      this.schedulesRepo.findTodayOverlay(groupId, organizationId),
    ]);
    if (!planGroup) {
      // Same 404 shape getMeals raised on the legacy path (its duplicate
      // group lookup used to produce this error).
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }
    const plannerOn =
      planGroup.weeklyMenuEnabled || planGroup.dayWiseMealsEnabled;

    if (result.data.length > 0) {
      // Additive: overlay the active planner schedule (Weekly / Day-Wise Meal
      // Mode) onto today's meals so per-day attendance window, preference
      // enforcement and meal visibility follow admin configuration. Attendance,
      // analytics, history and notifications stay unchanged (same mealId/date).
      if (plannerOn) {
        const overlay = plannerOverlay;
        const overlaid =
          overlay.size > 0
            ? result.data
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
                    // #3: per-day control of MULTI-preference groups. When the
                    // admin turns preferences OFF for this day in the weekly
                    // planner, hide the meal's master preference groups too (not
                    // just the flat tags) so members pick nothing that day. The
                    // master meal config is untouched — this is a per-day
                    // presentation overlay only (no schema change).
                    if (o.preferencesEnabled === false) {
                      next.preferenceGroups = [];
                    }
                  }
                  // #3: per-day SUBSET of master preference groups. A non-empty
                  // list narrows the meal's groups to just those IDs for this
                  // day; empty = inherit ALL master groups (unchanged behaviour).
                  if (
                    o.enabledPreferenceGroupIds &&
                    o.enabledPreferenceGroupIds.length > 0 &&
                    Array.isArray(next.preferenceGroups)
                  ) {
                    const allow = new Set(o.enabledPreferenceGroupIds);
                    next.preferenceGroups = next.preferenceGroups.filter(
                      (g: any) => allow.has(g.id),
                    );
                  }
                  // Issue 3: per-day menu shown on the meal card + detail screen.
                  if (o.menuItems && o.menuItems.length > 0) {
                    next.menuItems = o.menuItems;
                  }
                  // Additive: per-day description override (null = inherit master).
                  if (o.description != null && o.description !== '') {
                    next.description = o.description;
                  }
                  // Additive: per-day image override (null = inherit master image).
                  if (o.imageUrl != null && o.imageUrl !== '') {
                    next.imageUrl = o.imageUrl;
                  }
                  // Additive: per-day price override (null = inherit master).
                  if (o.price != null) {
                    next.price = o.price;
                  }
                  return next;
                })
            : [];
        // FR-MEAL-007 (ISSUE-18): a per-day window override can move a meal
        // earlier/later than its template slot — re-sort so the list stays
        // chronological by the EFFECTIVE open time shown to the student.
        overlaid.sort((a: any, b: any) => {
          const ak = MealsService.windowOpenMinutes(a);
          const bk = MealsService.windowOpenMinutes(b);
          if (ak !== bk) return ak - bk;
          return (a.order ?? 0) - (b.order ?? 0);
        });
        // Issue 1 — planner mode (Weekly / Day-Wise) is PUBLISHED-driven. Students
        // read the PUBLISHED snapshot ONLY (findTodayOverlay reads
        // publishedSnapshot, which is PRESERVED while the admin edits a draft — so
        // students keep seeing the last published schedule during a draft). An
        // empty overlay means the published schedule has no meal for today
        // (off-day) or nothing has ever been published → show NO meals. Never
        // master meals, never draft data.
        // Preference groups were already attached in listGroupMeals (above), so
        // result.data — and therefore the overlaid copies — already carry them.
        // The per-day OFF→[] clear and SUBSET filter above operate on those
        // real groups. Re-attaching here would clobber the subset, so we don't.
        return this.withWindowMeta(
          PaginatedResponseDto.of(overlaid, overlaid.length, 1, 50),
          planGroup,
          organizationId,
        );
      }
      return this.withWindowMeta(result, planGroup, organizationId);
    }

    // No active meals. Only provide the implicit attendance slot when the meal
    // system is DISABLED for this group (true attendance-only mode). When meals
    // are ENABLED but none configured, attendance is intentionally blocked.
    if (planGroup && planGroup.mealsEnabled === false) {
      const slot = await this.ensureGeneralSlot(groupId, organizationId);
      return this.withWindowMeta(
        PaginatedResponseDto.of([MealSerializer.toResponse(slot)], 1, 1, 50),
        planGroup,
        organizationId,
      );
    }

    return this.withWindowMeta(
      PaginatedResponseDto.of([], 0, 1, 50),
      planGroup,
      organizationId,
    );
  }

  /**
   * SRS FR-TIME-008/011 (LOOP-092): decorate today's meal list with the
   * canonical per-meal window state plus the server clock and the group's
   * grace period, so clients reconcile clock skew and disable controls
   * proactively instead of trusting the device clock. Purely additive fields —
   * older clients ignore them.
   */
  private async withWindowMeta(
    response: any,
    group: { attendanceGraceMinutes?: number | null } | null,
    organizationId: string,
  ) {
    const timezone =
      await this.groupsRepo.getOrganizationTimezone(organizationId);
    const nowHHmm = getCurrentTimeInTimezone(timezone);
    const graceMinutes = Math.max(0, group?.attendanceGraceMinutes ?? 0);
    // Minutes since org-midnight at serialization time. Clients evaluate the
    // attendance window against THIS clock (advanced by device-side elapsed
    // time), never the device wall clock — a wrong phone timezone/clock can
    // no longer enable a button the server will 423, or disable one the
    // server would accept (grace included).
    const [nowH, nowM] = nowHHmm.split(':').map(Number);
    const orgClockMinutes = nowH * 60 + nowM;
    // Org-timezone business date — clients mark attendance with THIS date so a
    // wrong phone calendar can no longer produce the "can only mark for today"
    // 400 (mark validation compares against the same org-TZ today).
    const orgDate = getTodayInTimezone(timezone);
    for (const m of response.data ?? []) {
      m.windowState = getWindowState(
        nowHHmm,
        m?.attendanceWindow?.openTime ?? null,
        m?.attendanceWindow?.closeTime ?? null,
        graceMinutes,
      );
      // Per-meal copies so they survive per-item model parsing on clients.
      m.orgClockMinutes = orgClockMinutes;
      m.graceMinutes = graceMinutes;
      m.orgDate = orgDate;
    }
    response.serverTime = new Date().toISOString();
    response.timezone = timezone;
    response.graceMinutes = graceMinutes;
    response.orgClockMinutes = orgClockMinutes;
    response.orgDate = orgDate;
    return response;
  }

  /**
   * FR-MEAL-007: serialized meal response → minutes-since-midnight of its
   * attendance-window open time; missing/invalid windows sort last.
   */
  private static windowOpenMinutes(m: any): number {
    return hhmmToMinutes(m?.attendanceWindow?.openTime);
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
    const response: any = MealSerializer.toResponse(meal);
    await this.attachPreferenceGroups([response], organizationId);
    return response;
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

    // Issue 3: once today's attendance window has opened, the meal price is
    // locked. Historical bills are already protected by the per-record price
    // snapshot; this guard prevents the master price from being changed after
    // attendance has started for the day. Only an actual PRICE CHANGE is
    // blocked — every other field stays editable, and new prices can still be
    // set before the window opens.
    if (
      dto.price !== undefined &&
      (dto.price ?? null) !== (existing.price ?? null) &&
      existing.attendanceWindowOpen &&
      existing.attendanceWindowClose
    ) {
      const timezone = await this.mealsRepo.getOrganizationTimezone(
        organizationId,
      );
      const nowHHmm = getCurrentTimeInTimezone(timezone);
      // Lock the price ONLY while today's attendance window is currently open
      // (open <= now <= close). Before it opens or after it closes the price is
      // editable again and the change applies to future occurrences; historical
      // records always keep their per-record price snapshot.
      if (
        nowHHmm >= existing.attendanceWindowOpen &&
        nowHHmm <= existing.attendanceWindowClose
      ) {
        throw new BadRequestException({
          message:
            'Meal price cannot be changed while attendance is open for this meal.',
          errors: {
            price: `Locked until the window closes at ${existing.attendanceWindowClose}`,
          },
        });
      }
    }

    // Build update payload — only include explicitly provided fields
    // SRS Module 03 MMT-003: renaming must not collide with another active
    // meal in the same group (case-insensitive).
    if (dto.name !== undefined && dto.name !== existing.name) {
      if (
        await this.mealsRepo.existsByNameInGroup(
          existing.groupId,
          organizationId,
          dto.name,
          id,
        )
      ) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors: { name: 'A meal with this name already exists in this group' },
        });
      }
    }

    // SRS Module 03 MODE-003: window-only fields in Attendance-Only groups.
    const parentGroup = await this.groupsRepo.findById(
      existing.groupId,
      organizationId,
    );
    const attendanceOnly = parentGroup ? !parentGroup.mealsEnabled : false;
    if (attendanceOnly) {
      this.assertAttendanceOnlyFields({
        price: dto.price ?? null,
        preferencesEnabled: dto.preferencesEnabled,
        enabledPreferences: dto.enabledPreferences,
        menuItems: dto.menuItems,
        imageUrl: dto.imageUrl ?? null,
      });
    }

    // SRS Module 03 MMT-001/MMT-014 + MODE-003.2: re-enabling an archived
    // meal/window counts against the same cap as creating one.
    if (dto.isEnabled === true && existing.isActive === false) {
      const cap = attendanceOnly
        ? this.attendanceMaxWindows
        : this.maxMealsPerGroup;
      const activeCount = await this.mealsRepo.countActiveInGroup(
        existing.groupId,
        organizationId,
        GENERAL_ATTENDANCE_SLOT_KEY,
      );
      if (activeCount >= cap) {
        throw new BadRequestException({
          message: `A group supports at most ${cap} ${attendanceOnly ? 'attendance windows' : 'meals'}`,
          errors: {
            isEnabled: `Limit reached (${cap}) — disable or delete an existing one first`,
          },
        });
      }
    }

    const updateData: Parameters<typeof this.mealsRepo.update>[2] = {};

    // SRS Module 03 MMT-002: the Slot Key is IMMUTABLE after creation — it is
    // the analytics/billing continuity key (per-slot rollups, snapshots). A
    // slotKey in the patch body is ignored; the Flutter app never sends one.
    if (dto.name !== undefined)       updateData.name = dto.name;
    if ('displayName' in dto)         updateData.displayName = dto.displayName ?? null;
    if (dto.order !== undefined)      updateData.order = dto.order;
    if (dto.isEnabled !== undefined)  updateData.isActive = dto.isEnabled; // isEnabled → isActive
    if (dto.attendanceEnabled !== undefined) updateData.attendanceEnabled = dto.attendanceEnabled;
    if ('description' in dto)         updateData.description = dto.description ?? null;
    if (dto.menuItems !== undefined)  updateData.menuItems = dto.menuItems;
    if ('imageUrl' in dto)            updateData.imageUrl = await this.resolveMealImageUrl(organizationId, id, dto.imageUrl, existing.imageUrl) ?? null;
    if (dto.preferencesEnabled !== undefined) updateData.preferencesEnabled = dto.preferencesEnabled;
    if (dto.enabledPreferences !== undefined) {
      // SRS Module 03 PREF-006.1: standalone tag cap.
      this.assertStandaloneTagCap(dto.enabledPreferences);
      updateData.enabledPreferences = dto.enabledPreferences;
    }
    if (dto.price !== undefined) updateData.price = dto.price;

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

    // SRS Module 03 MMT-011: a deleted master meal is removed from all future
    // days — purge its entries from every DRAFT schedule right away so the
    // planner never shows a ghost meal and publish is never blocked. Published
    // schedules stay untouched (members keep the last published version until
    // re-publish, where the publish self-heal drops the stale entries).
    // Historical attendance/billing stay intact via the immutable slot key and
    // per-record price snapshots (MMT-012/013).
    const purgedDraftEntries = await this.schedulesRepo.deleteDraftEntriesForMeal(
      id,
      organizationId,
    );

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'Meal',
      action: 'delete',
      metadata: { soft: true, purgedDraftEntries },
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
