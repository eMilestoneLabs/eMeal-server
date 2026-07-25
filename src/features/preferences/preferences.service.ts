import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PreferenceGroupsRepository } from './repositories/preference-groups.repository';
import { PreferenceGroupSerializer } from './serializers/preference-group.serializer';
import { RedisService } from '../../redis/redis.service';
import { invalidateTodayMealsCache } from '../meals/utils/today-meals-cache.util';
import {
  isSystemNonePreference,
  SYSTEM_NONE_GROUP_KEY,
  SYSTEM_NONE_LABEL,
} from '../../common/utils/system-none.util';
import {
  CreatePreferenceGroupDto,
  UpdatePreferenceGroupDto,
  PreferenceOptionDto,
  UpdatePreferenceOptionDto,
  PreferenceSelectionDto,
} from './dto/preference-group.dto';

/**
 * Live-Test-11 ISSUE-008: reserved key of the SYSTEM "None" option that is
 * automatically appended (last) to every effective preference group. It means
 * "attending, but no optional item": satisfies required groups, bills ₹0,
 * carries no quantity/inventory, is mutually exclusive with every other pick,
 * cannot be created/edited/deleted by admins, and never counts toward the
 * 2–5 option limit (it is virtual — never stored in the DB).
 */
export const NONE_OPTION_KEY = SYSTEM_NONE_GROUP_KEY;

/** Display label snapshotted for NONE rows (dashboard shows it separately). */
export const NONE_OPTION_LABEL = SYSTEM_NONE_LABEL;

/**
 * ISSUE-005 (system NONE): true when a FLAT preference value is the system
 * "None" tag — either the standalone 'none' key the clients send or the
 * group-mode '__none__' option key. Case/whitespace tolerant so every
 * validation site (members, guests, corrections) shares one rule.
 *
 * Live-Test-13: the implementation moved to `common/utils/system-none.util`
 * so repositories and workers can share it without importing a feature
 * service. Re-exported here unchanged — every existing importer keeps working.
 */
export { isSystemNonePreference };

/** The resolved, per-meal-effective shape used by validation and embedding. */
export interface EffectivePreferenceGroup {
  id: string;
  label: string;
  description: string | null;
  order: number;
  selectionType: string;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  quantityEnabled: boolean;
  visibleWhen: { groupId: string; optionKey: string } | null;
  vegOnly: boolean;
  options: Array<{
    id: string;
    key: string;
    label: string;
    emoji: string | null;
    color: string | null;
    isVeg: boolean;
    priceDelta: number;
    minQty: number;
    maxQty: number;
    order: number;
  }>;
}

/** Result of a validated selection set — everything attendance needs to persist. */
export interface ValidatedSelections {
  /** Σ(priceDelta × quantity) across all selections, in minor units. */
  totalDelta: number;
  /** Derived legacy primary (first required group's option) — FR-PG-100. */
  primaryKey: string | null;
  /** Immutable JSON snapshot for AttendanceRecord.preferences (FR-PG-013). */
  snapshot: Array<Record<string, unknown>>;
  /** Child rows for attendance_preference_selections (FR-PG-013). */
  rows: Array<{
    preferenceGroupId: string;
    groupLabelSnapshot: string;
    optionKey: string;
    optionLabelSnapshot: string;
    isVegSnapshot: boolean;
    priceDeltaSnapshot: number;
    quantity: number;
  }>;
}

/**
 * PreferencesService — Module 36 multi-dimensional preference groups (FR-PG-*).
 *
 * Owns: admin config CRUD with validation (FR-PG-081), reusable templates
 * (FR-PG-022), per-meal effective resolution with overrides (FR-PG-012/020),
 * and the server-authoritative selection validator + pricer used by attendance
 * (FR-PG-031/032/040/041/060/061). Legacy flat enabledPreferences[] meals are
 * untouched — a meal with zero bound groups behaves exactly as before
 * (FR-PG-021/100). organizationId is ALWAYS from the JWT.
 */
@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name);

  constructor(
    private readonly repo: PreferenceGroupsRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Optional() @Inject('REALTIME_GATEWAY')
    private readonly realtime: {
      emitMealUpdated(organizationId: string, payload: unknown): void;
    } | null = null,
    // Perf (2026-07-19): GET /meals/today bundle cache — preference edits
    // change the per-meal preferenceGroups it carries. @Optional keeps unit
    // tests constructing the service unchanged.
    @Optional()
    @Inject(RedisService)
    private readonly redis: RedisService | null = null,
  ) {}

  private cfg(key: string, fallback: number): number {
    return this.config.get<number>(`preferences.${key}`) ?? fallback;
  }

  // ── Effective resolution (FR-PG-012/020) ───────────────────────────────────

  /**
   * Live-Test-6 ISSUE-2 root cause: apply a published day entry's preference
   * override to the master effective groups — the EXACT rule /meals/today
   * uses to RENDER them (meals.service planner overlay). Validation must use
   * the same day-effective set the member was shown, otherwise a day that
   * disables or narrows preferences makes Present un-markable (client sends
   * the day set, server demanded the master set → 422 forever).
   *   preferencesEnabled === false  → no groups apply that day
   *   enabledPreferenceGroupIds ≠ [] → narrow to that subset
   *   anything else                 → inherit the master set unchanged
   */
  applyDayOverride(
    groups: EffectivePreferenceGroup[],
    override:
      | {
          preferencesEnabled: boolean | null;
          enabledPreferenceGroupIds: string[];
        }
      | null
      | undefined,
  ): EffectivePreferenceGroup[] {
    if (!override || groups.length === 0) return groups;
    let next = groups;
    if (override.preferencesEnabled === false) next = [];
    if (
      next.length > 0 &&
      Array.isArray(override.enabledPreferenceGroupIds) &&
      override.enabledPreferenceGroupIds.length > 0
    ) {
      const allow = new Set(override.enabledPreferenceGroupIds);
      next = next.filter((g) => allow.has(g.id));
    }
    return next;
  }

  /** Effective groups for ONE meal (active groups, active options, overrides). */
  async getEffectiveGroupsForMeal(
    mealId: string,
    organizationId: string,
  ): Promise<EffectivePreferenceGroup[]> {
    const map = await this.getEffectiveGroupsForMeals([mealId], organizationId);
    return map.get(mealId) ?? [];
  }

  /** Batch variant for /meals/today — one query for N meals (no N+1). */
  async getEffectiveGroupsForMeals(
    mealIds: string[],
    organizationId: string,
  ): Promise<Map<string, EffectivePreferenceGroup[]>> {
    const bindings = await this.repo.listBindingsForMeals(mealIds);
    return this.buildEffectiveGroupsFromBindings(bindings, organizationId);
  }

  /**
   * command_6 ultra pass: pure in-process builder shared by
   * getEffectiveGroupsForMeals AND the meal-list include path, where the
   * bindings already rode the meal query itself — zero extra round trips.
   * Identical mapping/filtering/sorting to the legacy path.
   */
  buildEffectiveGroupsFromBindings(
    bindings: any[],
    organizationId: string,
  ): Map<string, EffectivePreferenceGroup[]> {
    const result = new Map<string, EffectivePreferenceGroup[]>();
    for (const b of bindings) {
      const g = b.preferenceGroup;
      // Live-Test-8 ISSUE-001/002: SUSPENDED bindings (meal in Standalone
      // mode) drop out of every effective view — rendering, validation,
      // guests, auto-attendance — while staying stored for restore.
      if (b.isActive === false) continue;
      // Tenant isolation + soft-deleted groups drop out of the effective view.
      if (!g || g.organizationId !== organizationId || !g.isActive) continue;
      const options = g.options
        .filter((o) => o.isActive)
        .map((o) => ({
          id: o.id,
          key: o.key,
          label: o.label,
          emoji: o.emoji,
          color: o.color,
          isVeg: o.isVeg,
          priceDelta: o.priceDelta,
          minQty: o.minQty,
          maxQty: o.maxQty,
          order: o.order,
        }));
      // ISSUE-008: the SYSTEM "None" option — always available, always LAST,
      // ₹0, veg-safe, quantity-locked to 1. Virtual (never stored), so it can
      // never count toward the 2–5 option cap nor be edited by admins. Only
      // appended when the group has at least one real option — a group with
      // zero selectable options keeps its legacy auto-satisfied fail-safe.
      if (options.length > 0) {
        options.push({
          id: NONE_OPTION_KEY,
          key: NONE_OPTION_KEY,
          label: NONE_OPTION_LABEL,
          emoji: null,
          color: null,
          isVeg: true,
          priceDelta: 0,
          minQty: 1,
          maxQty: 1,
          order: (options[options.length - 1]?.order ?? 0) + 1,
        });
      }
      const effective: EffectivePreferenceGroup = {
        id: g.id,
        label: g.label,
        description: g.description,
        order: b.order,
        selectionType: g.selectionType,
        minSelect: b.minSelectOverride ?? g.minSelect,
        maxSelect: b.maxSelectOverride ?? g.maxSelect,
        required: b.requiredOverride ?? g.required,
        quantityEnabled: g.quantityEnabled,
        visibleWhen: (g.visibleWhen as any) ?? null,
        vegOnly: g.vegOnly,
        options,
      };
      const list = result.get(b.mealId) ?? [];
      list.push(effective);
      result.set(b.mealId, list);
    }
    for (const list of result.values()) list.sort((a, b) => a.order - b.order);
    return result;
  }

  // ── Server-authoritative selection validation + pricing ────────────────────

  /**
   * FR-PG-031/032/040/041/060/061: validate a member's selection set against
   * the meal's effective groups and compute the total price delta. Throws 422
   * `PREFERENCE_SELECTION_INVALID` with per-group details on any violation.
   *
   * Fail-safe (extends FR-MEAL-026): a required group with ZERO active options
   * is treated as satisfied.
   */
  validateSelections(
    groups: EffectivePreferenceGroup[],
    selections: PreferenceSelectionDto[],
  ): ValidatedSelections {
    const details: Array<{ groupId: string; reason: string }> = [];
    const byGroup = new Map<string, PreferenceSelectionDto[]>();
    for (const s of selections) {
      const list = byGroup.get(s.groupId) ?? [];
      list.push(s);
      byGroup.set(s.groupId, list);
    }

    // FR-PG-060: a group is visible unless its visibleWhen dependency is unmet.
    const isVisible = (g: EffectivePreferenceGroup): boolean => {
      if (!g.visibleWhen?.groupId || !g.visibleWhen.optionKey) return true;
      const dep = byGroup.get(g.visibleWhen.groupId) ?? [];
      return dep.some((s) => s.optionKey === g.visibleWhen!.optionKey);
    };

    const knownGroupIds = new Set(groups.map((g) => g.id));
    for (const gid of byGroup.keys()) {
      if (!knownGroupIds.has(gid)) {
        details.push({ groupId: gid, reason: 'Unknown preference group for this meal' });
      }
    }

    let totalDelta = 0;
    let primaryKey: string | null = null;
    const snapshot: Array<Record<string, unknown>> = [];
    const rows: ValidatedSelections['rows'] = [];
    const maxQtyCap = this.cfg('maxQuantityCap', 10);

    for (const g of groups) {
      const chosen = byGroup.get(g.id) ?? [];
      if (!isVisible(g)) {
        // Hidden groups are neither required nor billed (FR-PG-060).
        if (chosen.length > 0) {
          details.push({ groupId: g.id, reason: `"${g.label}" does not apply to your selection` });
        }
        continue;
      }
      // Fail-safe: required group with no SELECTABLE options = satisfied.
      // Live-Test-5 ISSUE-2: "selectable" must match what the member can
      // actually pick — a vegOnly group only offers its veg options (FR-PG-061
      // rejects everything else), so a required vegOnly group whose active
      // options are all non-veg used to make the meal permanently unmarkable
      // (client hides it, server demanded it → 422 forever).
      // ISSUE-008: the virtual NONE option is excluded from this emptiness
      // check — it must never turn a legacy auto-satisfied group into one
      // that suddenly demands an explicit pick.
      const selectable = (g.vegOnly
        ? g.options.filter((o) => o.isVeg)
        : g.options
      ).filter((o) => o.key !== NONE_OPTION_KEY);
      if (selectable.length === 0) continue;

      // ISSUE-008: NONE is mutually exclusive with every other pick in the
      // group — server-authoritative mirror of the client auto-deselect.
      const pickedNone = chosen.some((s) => s.optionKey === NONE_OPTION_KEY);
      if (pickedNone && chosen.length > 1) {
        details.push({
          groupId: g.id,
          reason: `"${NONE_OPTION_LABEL}" cannot be combined with other ${g.label} picks`,
        });
        continue;
      }

      const min = g.required ? Math.max(g.minSelect, 1) : 0;
      const max = Math.min(Math.max(g.maxSelect, min || 1), selectable.length);
      // ISSUE-008: a lone NONE satisfies any required group (min) and is
      // always within max (it is exactly one pick that means "no item").
      if (!pickedNone && chosen.length < min) {
        details.push({ groupId: g.id, reason: `Choose a ${g.label} option` });
        continue;
      }
      if (!pickedNone && chosen.length > max) {
        details.push({ groupId: g.id, reason: `Choose at most ${max} ${g.label} option(s)` });
        continue;
      }

      const seen = new Set<string>();
      for (const s of chosen) {
        if (seen.has(s.optionKey)) {
          details.push({ groupId: g.id, reason: `Duplicate option "${s.optionKey}"` });
          continue;
        }
        seen.add(s.optionKey);
        const opt = g.options.find((o) => o.key === s.optionKey);
        if (!opt) {
          details.push({ groupId: g.id, reason: `"${s.optionKey}" is not available in ${g.label}` });
          continue;
        }
        // FR-PG-061: veg-only groups never accept non-veg options.
        if (g.vegOnly && !opt.isVeg) {
          details.push({ groupId: g.id, reason: `${g.label} is veg-only` });
          continue;
        }
        const qty = g.quantityEnabled ? (s.quantity ?? opt.minQty) : 1;
        const qMax = Math.min(opt.maxQty, maxQtyCap);
        if (g.quantityEnabled && (qty < opt.minQty || qty > qMax)) {
          details.push({
            groupId: g.id,
            reason: `${opt.label} quantity must be between ${opt.minQty} and ${qMax}`,
          });
          continue;
        }
        totalDelta += opt.priceDelta * qty;
        if (primaryKey === null && g.required) primaryKey = opt.key;
        snapshot.push({
          groupId: g.id,
          groupLabel: g.label,
          optionKey: opt.key,
          optionLabel: opt.label,
          isVeg: opt.isVeg,
          priceDelta: opt.priceDelta,
          quantity: qty,
        });
        rows.push({
          preferenceGroupId: g.id,
          groupLabelSnapshot: g.label,
          optionKey: opt.key,
          optionLabelSnapshot: opt.label,
          isVegSnapshot: opt.isVeg,
          priceDeltaSnapshot: opt.priceDelta,
          quantity: qty,
        });
      }
    }

    if (details.length > 0) {
      throw new HttpException(
        {
          message: 'Your meal selection is incomplete or invalid',
          errorCode: 'PREFERENCE_SELECTION_INVALID',
          errors: { selections: details.map((d) => d.reason).join('; ') },
          details,
          statusCode: 422,
        },
        422,
      );
    }
    if (primaryKey === null && rows.length > 0) primaryKey = rows[0].optionKey;
    return { totalDelta, primaryKey, snapshot, rows };
  }

  // ── Admin config CRUD (FR-PG-080/081/090) ──────────────────────────────────

  /**
   * Effective groups for a meal — member/admin read (org-isolated).
   * Live-Test-8 ISSUE-001/002 (additive field): `suspended` carries the
   * meal's SUSPENDED bindings (Standalone mode active) in the same shape, so
   * the admin Preference Builder can show "saved — restores on switch back"
   * without a second request. `data` keeps its exact prior meaning (active
   * effective groups only) — member surfaces are untouched.
   */
  async listForMeal(mealId: string, organizationId: string) {
    await this.assertMeal(mealId, organizationId);
    const bindings = await this.repo.listBindingsForMeal(mealId);
    const groups =
      this.buildEffectiveGroupsFromBindings(bindings, organizationId).get(
        mealId,
      ) ?? [];
    // Suspended bindings re-enter the SAME mapper with the suspension lifted
    // so both lists serialize identically (DRY — one shape, one mapper).
    const suspendedBindings = bindings
      .filter((b: any) => b.isActive === false)
      .map((b: any) => ({ ...b, isActive: true }));
    const suspended =
      suspendedBindings.length > 0
        ? (this.buildEffectiveGroupsFromBindings(
            suspendedBindings,
            organizationId,
          ).get(mealId) ?? [])
        : [];
    return { data: groups, suspended };
  }

  /**
   * Live-Test-8 ISSUE-001/002: suspend (Standalone mode) or restore (Groups
   * mode) ALL of a meal's preference-group bindings — the non-destructive
   * mode switch. Nothing is deleted; the effective view simply excludes
   * suspended bindings everywhere (rendering, validation, guests, sweeps).
   */
  async setMealBindingsActive(
    adminId: string,
    organizationId: string,
    mealId: string,
    active: boolean,
    requestId?: string,
  ) {
    const meal = await this.assertMeal(mealId, organizationId);
    const result = await this.repo.setBindingsActive(mealId, active);
    this.auditConfig(
      organizationId,
      adminId,
      mealId,
      'update',
      { bindingsActive: active, bindingsAffected: result.count },
      requestId,
    );
    this.emitConfigChanged(organizationId, meal.groupId, mealId);
    return { success: true, affected: result.count };
  }

  /**
   * POST /meals/:id/preference-groups — either bind an existing template
   * (dto.preferenceGroupId) or create a meal-scoped group (+options) and bind.
   */
  async createForMeal(
    adminId: string,
    organizationId: string,
    mealId: string,
    dto: CreatePreferenceGroupDto,
    requestId?: string,
  ) {
    const meal = await this.assertMeal(mealId, organizationId);

    const maxGroups = this.cfg('maxGroupsPerMeal', 5);
    // One query serves both rules: the cap (count) and UNI-022 label
    // uniqueness (labels of the already-bound groups).
    const existingBindings = await this.repo.listBindingsForMeal(mealId);
    const bound = existingBindings.length;
    if (bound >= maxGroups) {
      throw new BadRequestException({
        message: `A meal supports at most ${maxGroups} preference groups`,
        errors: { mealId: 'Group limit reached' },
      });
    }

    // UNI-022 (uniqueness audit): preference-group names are unique within the
    // meal (trim + lowercase). Applies to both paths — creating a meal-scoped
    // group AND binding an existing template.
    const assertLabelUnique = (label: string, selfGroupId?: string) => {
      const norm = label.trim().toLowerCase();
      const clash = existingBindings.find(
        (b: any) =>
          b.preferenceGroupId !== selfGroupId &&
          (b.preferenceGroup?.label ?? '').trim().toLowerCase() === norm,
      );
      if (clash) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: {
            label: `A preference group named "${label.trim()}" already exists for this meal`,
          },
        });
      }
    };

    let groupId: string;
    if (dto.preferenceGroupId) {
      // Bind an existing template (FR-PG-022) — must belong to this org.
      const template = await this.repo.findById(dto.preferenceGroupId, organizationId);
      if (!template || !template.isActive) {
        throw new NotFoundException('Preference group template not found');
      }
      assertLabelUnique(template.label, template.id);
      groupId = template.id;
    } else {
      assertLabelUnique(dto.label);
      this.validateGroupRules(dto);
      // Live-Test-7 ISSUE-2: creation-time floor — 2..5 options per group.
      this.validateOptionList(dto.options ?? [], true);
      // Live-Test-11 ISSUE-014: Veg-Only is the PARENT policy — every option
      // inside a veg-only group is automatically veg.
      if (dto.vegOnly === true) {
        for (const o of dto.options ?? []) o.isVeg = true;
      }
      const created = await this.repo.createGroup({
        organizationId,
        groupId: meal.groupId,
        scope: 'meal',
        label: dto.label,
        description: dto.description ?? null,
        order: dto.order ?? 0,
        selectionType: dto.selectionType ?? 'single',
        minSelect: dto.minSelect ?? (dto.required === false ? 0 : 1),
        maxSelect: dto.maxSelect ?? 1,
        required: dto.required ?? true,
        quantityEnabled: dto.quantityEnabled ?? false,
        visibleWhen: dto.visibleWhen ?? null,
        vegOnly: dto.vegOnly ?? false,
        options: dto.options,
      });
      groupId = created.id;
    }

    // SRS Module 03 PREF-005: a per-meal Max Picks override obeys the same cap.
    const maxSelectCap = this.cfg('maxSelectCap', 3);
    if (dto.maxSelectOverride != null && dto.maxSelectOverride > maxSelectCap) {
      throw new BadRequestException({
        message: `Max Picks cannot exceed ${maxSelectCap}`,
        errors: { maxSelectOverride: `Capped at ${maxSelectCap}` },
      });
    }

    const binding = await this.repo.bindToMeal({
      mealId,
      preferenceGroupId: groupId,
      order: dto.order ?? bound,
      requiredOverride: dto.requiredOverride ?? null,
      minSelectOverride: dto.minSelectOverride ?? null,
      maxSelectOverride: dto.maxSelectOverride ?? null,
    });

    this.auditConfig(organizationId, adminId, groupId, 'create', { mealId }, requestId);
    this.emitConfigChanged(organizationId, meal.groupId, mealId);
    return PreferenceGroupSerializer.toResponse(binding.preferenceGroup, binding);
  }

  /** PATCH /preference-groups/:id (FR-PG-080/081). */
  async updateGroup(
    adminId: string,
    organizationId: string,
    id: string,
    dto: UpdatePreferenceGroupDto,
    requestId?: string,
  ) {
    const existing = await this.repo.findById(id, organizationId);
    if (!existing) throw new NotFoundException('Preference group not found');

    this.validateGroupRules({
      selectionType: dto.selectionType ?? existing.selectionType,
      minSelect: dto.minSelect ?? existing.minSelect,
      maxSelect: dto.maxSelect ?? existing.maxSelect,
      required: dto.required ?? existing.required,
    });
    // FR-PG-081: maxSelect may never exceed the active option count (when any).
    const activeOptions = existing.options.filter((o) => o.isActive).length;
    const nextMax = dto.maxSelect ?? existing.maxSelect;
    if (activeOptions > 0 && nextMax > activeOptions) {
      throw new BadRequestException({
        message: `maxSelect (${nextMax}) exceeds active option count (${activeOptions})`,
        errors: { maxSelect: 'Exceeds option count' },
      });
    }

    // Live-Test-11 ISSUE-014: turning Veg-Only ON cascades — every option in
    // the group becomes veg (the group is the parent policy). Runs BEFORE the
    // group update so the returned payload reflects the cascaded options.
    if (dto.vegOnly === true && existing.vegOnly !== true) {
      await this.prisma.preferenceOption.updateMany({
        where: { preferenceGroupId: id },
        data: { isVeg: true },
      });
    }
    const updated = await this.repo.updateGroup(id, organizationId, {
      ...dto,
      visibleWhen: dto.visibleWhen === undefined ? undefined : dto.visibleWhen,
    });
    this.auditConfig(organizationId, adminId, id, 'update', dto as any, requestId);
    this.emitConfigChanged(organizationId, existing.groupId, null);
    return PreferenceGroupSerializer.toResponse(updated);
  }

  /** DELETE /preference-groups/:id — soft deactivate (FR-PG-072). */
  async deactivateGroup(
    adminId: string,
    organizationId: string,
    id: string,
    requestId?: string,
  ) {
    const existing = await this.repo.findById(id, organizationId);
    if (!existing) throw new NotFoundException('Preference group not found');
    await this.repo.updateGroup(id, organizationId, { isActive: false });
    this.auditConfig(organizationId, adminId, id, 'delete', {}, requestId);
    this.emitConfigChanged(organizationId, existing.groupId, null);
    return { success: true };
  }

  /** DELETE /meals/:mealId/preference-groups/:id — unbind, keep the group. */
  async unbindFromMeal(
    adminId: string,
    organizationId: string,
    mealId: string,
    id: string,
    requestId?: string,
  ) {
    const meal = await this.assertMeal(mealId, organizationId);
    const existing = await this.repo.findById(id, organizationId);
    if (!existing) throw new NotFoundException('Preference group not found');
    await this.repo.unbindFromMeal(mealId, id);
    this.auditConfig(organizationId, adminId, id, 'update', { unboundFrom: mealId }, requestId);
    this.emitConfigChanged(organizationId, meal.groupId, mealId);
    return { success: true };
  }

  /** POST /preference-groups/:id/options (FR-PG-080/081). */
  async addOption(
    adminId: string,
    organizationId: string,
    groupId: string,
    dto: PreferenceOptionDto,
    requestId?: string,
  ) {
    const group = await this.repo.findById(groupId, organizationId);
    if (!group) throw new NotFoundException('Preference group not found');

    // SRS Module 03 PREF-006.3: cap counts ACTIVE options so deactivated tags
    // can be replaced without permanently consuming the quota.
    const maxOptions = this.cfg('maxOptionsPerGroup', 5);
    if (group.options.filter((o) => o.isActive).length >= maxOptions) {
      throw new BadRequestException({
        message: `A group supports at most ${maxOptions} options`,
        errors: { groupId: 'Option limit reached' },
      });
    }
    this.validateOptionList([dto]);
    // Live-Test-11 ISSUE-013: duplicate detection is CASE- and whitespace-
    // insensitive across keys AND display labels ("Ruti" vs "RUTI").
    const normKey = dto.key.trim().toLowerCase();
    const normLabel = (dto.label ?? dto.key).trim().toLowerCase();
    if (
      group.options.some(
        (o) =>
          o.isActive !== false &&
          (o.key.trim().toLowerCase() === normKey ||
            (o.label ?? o.key).trim().toLowerCase() === normLabel),
      )
    ) {
      throw new BadRequestException({
        message: `Option "${(dto.label ?? dto.key).trim()}" already exists in this group`,
        errors: { key: 'Duplicate option' },
      });
    }
    const option = await this.repo.createOption({
      preferenceGroupId: groupId,
      order: dto.order ?? group.options.length,
      ...dto,
      // Live-Test-11 ISSUE-014/010: the group is the PARENT policy — a new
      // option added to a veg-only group ALWAYS inherits Veg, regardless of
      // what the payload claims (same cascade as create/update-group).
      ...(group.vegOnly === true ? { isVeg: true } : {}),
    });
    this.auditConfig(organizationId, adminId, groupId, 'update', { addedOption: dto.key }, requestId);
    this.emitConfigChanged(organizationId, group.groupId, null);
    return PreferenceGroupSerializer.optionToResponse(option);
  }

  /** PATCH /preference-options/:id — key immutable (FR-PG-072). */
  async updateOption(
    adminId: string,
    organizationId: string,
    id: string,
    dto: UpdatePreferenceOptionDto,
    requestId?: string,
  ) {
    const option = await this.repo.findOptionById(id);
    if (!option || option.group.organizationId !== organizationId) {
      throw new NotFoundException('Preference option not found');
    }
    // ISSUE-008: an option can never be RENAMED into the system "None".
    if ((dto.label ?? '').trim().toLowerCase() === 'none') {
      throw new BadRequestException({
        message: `"${NONE_OPTION_LABEL}" is a system option`,
        errors: {
          label:
            'A "None" choice is added automatically to every group — options cannot take that name',
        },
      });
    }
    // Live-Test-11 ISSUE-014: inside a veg-only group the per-option veg flag
    // is locked ON — change the group's policy to change the options.
    if (dto.isVeg === false && option.group.vegOnly === true) {
      throw new UnprocessableEntityException({
        message: 'This group is Veg-Only — every option stays veg',
        errors: {
          isVeg: 'Turn off Veg-Only on the group to allow non-veg options',
        },
      });
    }
    if (dto.minQty !== undefined || dto.maxQty !== undefined) {
      const minQty = dto.minQty ?? option.minQty;
      const maxQty = dto.maxQty ?? option.maxQty;
      if (minQty > maxQty) {
        throw new BadRequestException({
          message: 'minQty cannot exceed maxQty',
          errors: { minQty: 'Invalid quantity bounds' },
        });
      }
    }
    // Live-Test-7 ISSUE-2: PATCHing isActive obeys the same 2..5 window the
    // create/add/delete paths enforce (floor on deactivate, cap on reactivate).
    if (dto.isActive === false && option.isActive !== false) {
      await this.assertActiveOptionFloor(option.group.id, organizationId);
    }
    if (dto.isActive === true && option.isActive === false) {
      const group = await this.repo.findById(option.group.id, organizationId);
      const maxOptions = this.cfg('maxOptionsPerGroup', 5);
      if (
        group &&
        group.options.filter((o) => o.isActive).length >= maxOptions
      ) {
        throw new BadRequestException({
          message: `A group supports at most ${maxOptions} options`,
          errors: { isActive: 'Option limit reached' },
        });
      }
    }
    const updated = await this.repo.updateOption(id, dto);
    this.auditConfig(organizationId, adminId, option.group.id, 'update', { optionId: id }, requestId);
    this.emitConfigChanged(organizationId, option.group.groupId, null);
    return PreferenceGroupSerializer.optionToResponse(updated);
  }

  /** DELETE /preference-options/:id — soft deactivate (FR-PG-072). */
  async deactivateOption(
    adminId: string,
    organizationId: string,
    id: string,
    requestId?: string,
  ) {
    const option = await this.repo.findOptionById(id);
    if (!option || option.group.organizationId !== organizationId) {
      throw new NotFoundException('Preference option not found');
    }
    // Live-Test-7 ISSUE-2: a live group may never drop below the option floor
    // (default 2) — a "choice" with one option is not a choice. Deactivate the
    // group itself to retire the whole set.
    if (option.isActive !== false) {
      await this.assertActiveOptionFloor(option.group.id, organizationId);
    }
    await this.repo.updateOption(id, { isActive: false });
    this.auditConfig(organizationId, adminId, option.group.id, 'update', { deactivatedOption: option.key }, requestId);
    this.emitConfigChanged(organizationId, option.group.groupId, null);
    return { success: true };
  }

  // ── Templates (FR-PG-022) ───────────────────────────────────────────────────

  async listTemplates(organizationId: string, groupId: string) {
    const templates = await this.repo.listTemplates(organizationId, groupId);
    // Meal-scoped groups are not reusable templates — only org/group scope.
    return { data: templates.filter((t) => t.scope !== 'meal').map((t) => PreferenceGroupSerializer.toResponse(t)) };
  }

  async createTemplate(
    adminId: string,
    organizationId: string,
    groupId: string,
    dto: CreatePreferenceGroupDto,
    requestId?: string,
  ) {
    this.validateGroupRules(dto);
    // Live-Test-7 ISSUE-2: creation-time floor — 2..5 options per group.
    this.validateOptionList(dto.options ?? [], true);
    // Live-Test-11 ISSUE-014: Veg-Only is the PARENT policy — every option
    // inside a veg-only group is automatically veg.
    if (dto.vegOnly === true) {
      for (const o of dto.options ?? []) o.isVeg = true;
    }
    // Live-Test-11 ISSUE-013: template (Preference Group) names are unique
    // within the Master Meal Template's group — case/whitespace-insensitive.
    const norm = dto.label.trim().toLowerCase();
    const templates = await this.repo.listTemplates(organizationId, groupId);
    if (
      templates.some(
        (t) =>
          t.scope !== 'meal' &&
          t.isActive !== false &&
          t.label.trim().toLowerCase() === norm,
      )
    ) {
      throw new ConflictException({
        message: 'Validation failed',
        errors: {
          label: `A preference group named "${dto.label.trim()}" already exists`,
        },
      });
    }
    const created = await this.repo.createGroup({
      organizationId,
      groupId,
      scope: 'group',
      label: dto.label,
      description: dto.description ?? null,
      order: dto.order ?? 0,
      selectionType: dto.selectionType ?? 'single',
      minSelect: dto.minSelect ?? (dto.required === false ? 0 : 1),
      maxSelect: dto.maxSelect ?? 1,
      required: dto.required ?? true,
      quantityEnabled: dto.quantityEnabled ?? false,
      visibleWhen: dto.visibleWhen ?? null,
      vegOnly: dto.vegOnly ?? false,
      options: dto.options,
    });
    this.auditConfig(organizationId, adminId, created.id, 'create', { template: true }, requestId);
    return PreferenceGroupSerializer.toResponse(created);
  }

  // ── Cross-tab analytics (FR-PG-050/051) ─────────────────────────────────────

  async getCrossTab(
    organizationId: string,
    groupId: string,
    dateStr: string,
    mealId?: string,
  ) {
    const date = new Date(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException({
        message: 'Invalid date',
        errors: { date: 'Use YYYY-MM-DD' },
      });
    }
    // Unknown or foreign-org groupId → explicit 404 instead of a 200-empty
    // crosstab (org isolation already held inside repo.crossTab; this matches
    // the billing-summary guard so cross-org probes can't distinguish ids).
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, organizationId },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    const rows = await this.repo.crossTab(organizationId, groupId, date, mealId);
    // Shape: [{groupId, groupLabel, options:[{key,label,count,totalQuantity}]}]
    const byGroup = new Map<string, any>();
    for (const r of rows) {
      const entry = byGroup.get(r.preferenceGroupId) ?? {
        groupId: r.preferenceGroupId,
        groupLabel: r.groupLabelSnapshot,
        options: [],
      };
      entry.options.push({
        key: r.optionKey,
        label: r.optionLabelSnapshot,
        count: r._count._all,
        totalQuantity: r._sum.quantity ?? r._count._all,
      });
      byGroup.set(r.preferenceGroupId, entry);
    }
    const data = [...byGroup.values()];
    for (const g of data) {
      g.options.sort((a: any, b: any) => b.count - a.count);
    }
    return { date: dateStr, mealId: mealId ?? null, data };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async assertMeal(mealId: string, organizationId: string) {
    const meal = await this.prisma.meal.findFirst({
      where: { id: mealId, organizationId },
      select: { id: true, groupId: true },
    });
    if (!meal) throw new NotFoundException('Meal not found');
    return meal;
  }

  /** FR-PG-081 rule coherence. */
  private validateGroupRules(rules: {
    selectionType?: string;
    minSelect?: number;
    maxSelect?: number;
    required?: boolean;
  }): void {
    const selectionType = rules.selectionType ?? 'single';
    const required = rules.required ?? true;
    const minSelect = rules.minSelect ?? (required ? 1 : 0);
    const maxSelect = rules.maxSelect ?? 1;
    const errors: Record<string, string> = {};
    if (minSelect > maxSelect) errors.minSelect = 'minSelect cannot exceed maxSelect';
    if (selectionType === 'single' && maxSelect !== 1) {
      errors.maxSelect = 'single-select groups must have maxSelect = 1';
    }
    if (selectionType === 'multiple' && maxSelect < 2) {
      errors.maxSelect = 'multiple-select groups need maxSelect >= 2';
    }
    // SRS Module 03 PREF-005: Max Picks is capped (default 3, config-driven).
    const maxSelectCap = this.cfg('maxSelectCap', 3);
    if (maxSelect > maxSelectCap) {
      errors.maxSelect = `Max Picks cannot exceed ${maxSelectCap}`;
    }
    if (required && minSelect < 1) errors.minSelect = 'required groups need minSelect >= 1';
    if (!required && minSelect !== 0) errors.minSelect = 'optional groups must have minSelect = 0';
    if (Object.keys(errors).length > 0) {
      throw new BadRequestException({ message: 'Invalid preference group rule', errors });
    }
  }

  /** Live-Test-7 ISSUE-2: reject an option deactivation that would leave an
   *  ACTIVE group with fewer than the configured floor (default 2). Inactive
   *  groups can be drained freely — they render nowhere. */
  private async assertActiveOptionFloor(
    prefGroupId: string,
    organizationId: string,
  ): Promise<void> {
    const group = await this.repo.findById(prefGroupId, organizationId);
    if (!group || !group.isActive) return;
    const minOptions = this.cfg('minOptionsPerGroup', 2);
    if (group.options.filter((o) => o.isActive).length <= minOptions) {
      throw new BadRequestException({
        message: `A preference group needs at least ${minOptions} options`,
        errors: {
          options: `Keep at least ${minOptions} active options, or disable the group instead`,
        },
      });
    }
  }

  /** FR-PG-081 option coherence: unique keys, sane quantity bounds.
   *  Live-Test-7 ISSUE-2: `enforceMin` applies the creation-time floor
   *  (default 2, config-driven) — a choice needs at least two options.
   *  Incremental addOption passes single-item lists, so the floor is only
   *  asserted where the FULL option set is known (create paths). */
  private validateOptionList(
    options: PreferenceOptionDto[],
    enforceMin = false,
  ): void {
    const keys = new Set<string>();
    const maxQtyCap = this.cfg('maxQuantityCap', 10);
    if (enforceMin) {
      const minOptions = this.cfg('minOptionsPerGroup', 2);
      if (options.length < minOptions) {
        throw new BadRequestException({
          message: `A preference group needs at least ${minOptions} options`,
          errors: { options: `Add at least ${minOptions} options` },
        });
      }
    }
    // SRS Module 03 PREF-006.3: a group carries at most N tags (default 5) —
    // enforced here so inline creation (createForMeal / createTemplate) obeys
    // the same cap as incremental addOption.
    const maxOptions = this.cfg('maxOptionsPerGroup', 5);
    if (options.length > maxOptions) {
      throw new BadRequestException({
        message: `A group supports at most ${maxOptions} options`,
        errors: { options: 'Option limit reached' },
      });
    }
    // Live-Test-11 ISSUE-013: duplicates are CASE- and whitespace-insensitive
    // ("Ruti" vs "RUTI " is the same tag) — keys and display labels both.
    const labels = new Set<string>();
    for (const o of options) {
      const normKey = o.key.trim().toLowerCase();
      // ISSUE-008: "None" is a SYSTEM option — always present, always last,
      // never admin-managed. Reserve its key and label in both cases.
      if (
        normKey === NONE_OPTION_KEY ||
        normKey === 'none' ||
        (o.label ?? '').trim().toLowerCase() === 'none'
      ) {
        throw new BadRequestException({
          message: `"${NONE_OPTION_LABEL}" is a system option`,
          errors: {
            options:
              'A "None" choice is added automatically to every group — you do not need to create it',
          },
        });
      }
      if (keys.has(normKey)) {
        throw new BadRequestException({
          message: `Duplicate option key "${o.key}"`,
          errors: { key: 'Keys must be unique within a group' },
        });
      }
      keys.add(normKey);
      const normLabel = (o.label ?? o.key).trim().toLowerCase();
      if (labels.has(normLabel)) {
        throw new BadRequestException({
          message: `Duplicate option "${(o.label ?? o.key).trim()}"`,
          errors: { options: 'Option names must be unique within a group' },
        });
      }
      labels.add(normLabel);
      const minQty = o.minQty ?? 1;
      const maxQty = o.maxQty ?? 1;
      if (minQty > maxQty || maxQty > maxQtyCap) {
        throw new BadRequestException({
          message: `Invalid quantity bounds for "${o.key}" (max ${maxQtyCap})`,
          errors: { maxQty: 'Invalid quantity bounds' },
        });
      }
    }
  }

  private auditConfig(
    organizationId: string,
    actorId: string,
    targetId: string,
    action: 'create' | 'update' | 'delete',
    metadata: Record<string, unknown>,
    requestId?: string,
  ): void {
    this.audit.log({
      organizationId,
      actorId,
      targetId,
      targetType: 'PreferenceGroup',
      action,
      metadata,
      requestId,
    });
  }

  /** Clients refresh their meal cache on meal.updated.v1 — reuse it. */
  private emitConfigChanged(
    organizationId: string,
    groupId: string | null,
    mealId: string | null,
  ): void {
    // Perf (2026-07-19): preference edits ride the GET /meals/today bundle
    // (preferenceGroups per meal) — drop the shared Redis cache BEFORE the
    // realtime emit so a client refetch never re-reads stale. Fire-and-forget
    // chain keeps this helper sync for its 8 existing call sites; a Redis
    // outage degrades to TTL expiry (fail-soft inside the util).
    void invalidateTodayMealsCache(
      this.redis,
      organizationId,
      groupId ?? undefined,
    ).finally(() => {
      this.realtime?.emitMealUpdated(organizationId, {
        organizationId,
        groupId,
        mealId,
        reason: 'preference_groups_changed',
      });
    });
  }
}
