import { VacationRequestEntity } from '../entities/vacation-request.entity';

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * VacationRequestSerializer — converts an entity to the Flutter JSON contract.
 * start/end are date-only (YYYY-MM-DD); review timestamps are ISO-8601 or null.
 */
export class VacationRequestSerializer {
  static toResponse(v: VacationRequestEntity): Record<string, unknown> {
    return {
      id: v.id,
      organizationId: v.organizationId,
      groupId: v.groupId ?? null,
      userId: v.userId,
      userName: v.userName ?? null,
      startDate: dateOnly(v.startDate),
      endDate: dateOnly(v.endDate),
      reason: v.reason ?? null,
      status: v.status,
      reviewedBy: v.reviewedBy ?? null,
      reviewedAt: v.reviewedAt ? v.reviewedAt.toISOString() : null,
      reviewNote: v.reviewNote ?? null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    };
  }

  static toList(items: VacationRequestEntity[]): Record<string, unknown>[] {
    return items.map((v) => this.toResponse(v));
  }
}
