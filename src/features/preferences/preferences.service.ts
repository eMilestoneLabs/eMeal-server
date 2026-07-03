import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PreferenceGroupsRepository } from './repositories/preference-groups.repository';
import { PreferenceGroupSerializer } from './serializers/preference-group.serializer';
import {
  CreatePreferenceGroupDto,
  UpdatePreferenceGroupDto,
  PreferenceOptionDto,
  UpdatePreferenceOptionDto,
  PreferenceSelectionDto,
} from './dto/preference-group.dto';

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
  ) {}

  private cfg(key: string, fallback: number): number {
    return this.config.get<number>(`preferences.${key}`) ?? fallback;
  }

  // ── Effective resolution (FR-PG-012/020) ───────────────────────────────────

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
    const result = new Map<string, EffectivePreferenceGroup[]>();
    for (const b of bindings) {
      const g = b.preferenceGroup;
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
      // Fail-safe: required group with no active options = satisfied.
      if (g.options.length === 0) continue;

      const min = g.required ? Math.max(g.minSelect, 1) : 0;
      const max = Math.min(Math.max(g.maxSelect, min || 1), g.options.length);
      if (chosen.length < min) {
        details.push({ groupId: g.id, reason: `Choose a ${g.label} option` });
        continue;
      }
      if (chosen.length > max) {
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

  /** Effective groups for a meal — member/admin read (org-isolated). */
  async listForMeal(mealId: string, organizationId: string) {
    await this.assertMeal(mealId, organizationId);
    const groups = await this.getEffectiveGroupsForMeal(mealId, organizationId);
    return { data: groups };
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

    const maxGroups = this.cfg('maxGroupsPerMeal', 8);
    const bound = await this.repo.countBindingsForMeal(mealId);
    if (bound >= maxGroups) {
      throw new BadRequestException({
        message: `A meal supports at most ${maxGroups} preference groups`,
        errors: { mealId: 'Group limit reached' },
      });
    }

    let groupId: string;
    if (dto.preferenceGroupId) {
      // Bind an existing template (FR-PG-022) — must belong to this org.
      const template = await this.repo.findById(dto.preferenceGroupId, organizationId);
      if (!template || !template.isActive) {
        throw new NotFoundException('Preference group template not found');
      }
      groupId = template.id;
    } else {
      this.validateGroupRules(dto);
      this.validateOptionList(dto.options ?? []);
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

    const maxOptions = this.cfg('maxOptionsPerGroup', 15);
    if (group.options.length >= maxOptions) {
      throw new BadRequestException({
        message: `A group supports at most ${maxOptions} options`,
        errors: { groupId: 'Option limit reached' },
      });
    }
    this.validateOptionList([dto]);
    if (group.options.some((o) => o.key === dto.key)) {
      throw new BadRequestException({
        message: `Option key "${dto.key}" already exists in this group`,
        errors: { key: 'Duplicate key' },
      });
    }
    const option = await this.repo.createOption({
      preferenceGroupId: groupId,
      order: dto.order ?? group.options.length,
      ...dto,
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
    this.validateOptionList(dto.options ?? []);
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
    if (required && minSelect < 1) errors.minSelect = 'required groups need minSelect >= 1';
    if (!required && minSelect !== 0) errors.minSelect = 'optional groups must have minSelect = 0';
    if (Object.keys(errors).length > 0) {
      throw new BadRequestException({ message: 'Invalid preference group rule', errors });
    }
  }

  /** FR-PG-081 option coherence: unique keys, sane quantity bounds. */
  private validateOptionList(options: PreferenceOptionDto[]): void {
    const keys = new Set<string>();
    const maxQtyCap = this.cfg('maxQuantityCap', 10);
    for (const o of options) {
      if (keys.has(o.key)) {
        throw new BadRequestException({
          message: `Duplicate option key "${o.key}"`,
          errors: { key: 'Keys must be unique within a group' },
        });
      }
      keys.add(o.key);
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
    this.realtime?.emitMealUpdated(organizationId, {
      organizationId,
      groupId,
      mealId,
      reason: 'preference_groups_changed',
    });
  }
}
