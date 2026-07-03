/**
 * PreferenceGroupSerializer — Module 36 API shapes (FR-PG-090).
 * Flat camelCase, price deltas in minor units (client divides by 100).
 */
export class PreferenceGroupSerializer {
  static toResponse(
    group: {
      id: string;
      groupId?: string | null;
      scope?: string;
      label: string;
      description: string | null;
      order: number;
      selectionType: string;
      minSelect: number;
      maxSelect: number;
      required: boolean;
      quantityEnabled: boolean;
      visibleWhen?: unknown;
      vegOnly: boolean;
      isActive: boolean;
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
        isActive: boolean;
      }>;
    },
    binding?: {
      order: number;
      requiredOverride: boolean | null;
      minSelectOverride: number | null;
      maxSelectOverride: number | null;
    } | null,
  ) {
    return {
      id: group.id,
      scope: group.scope ?? 'group',
      label: group.label,
      description: group.description,
      order: binding?.order ?? group.order,
      selectionType: group.selectionType,
      minSelect: binding?.minSelectOverride ?? group.minSelect,
      maxSelect: binding?.maxSelectOverride ?? group.maxSelect,
      required: binding?.requiredOverride ?? group.required,
      quantityEnabled: group.quantityEnabled,
      visibleWhen: group.visibleWhen ?? null,
      vegOnly: group.vegOnly,
      isActive: group.isActive,
      options: group.options
        .filter((o) => o.isActive)
        .map((o) => this.optionToResponse(o)),
    };
  }

  static optionToResponse(o: {
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
    isActive?: boolean;
  }) {
    return {
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
    };
  }
}
