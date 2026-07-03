import { CorrectionRequestEntity } from '../entities/correction-request.entity';

/** Serializes CorrectionRequestEntity to the Flutter JSON contract. */
export class CorrectionRequestSerializer {
  static toResponse(r: CorrectionRequestEntity): Record<string, unknown> {
    return {
      id: r.id,
      groupId: r.groupId,
      userId: r.userId,
      userName: r.userName ?? null,
      mealId: r.mealId,
      mealName: r.mealName ?? null,
      // Date-only string — the meal's business date.
      attendanceDate: r.attendanceDate.toISOString().slice(0, 10),
      requestType: r.requestType,
      requestedStatus: r.requestedStatus ?? null,
      requestedPreference: r.requestedPreference ?? null,
      reason: r.reason ?? null,
      evidenceUrl: r.evidenceUrl ?? null,
      status: r.status,
      reviewedBy: r.reviewedBy ?? null,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      reviewNote: r.reviewNote ?? null,
      sourceChannel: r.sourceChannel,
      resultRecordId: r.resultRecordId ?? null,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    };
  }

  static toList(rows: CorrectionRequestEntity[]): Record<string, unknown>[] {
    return rows.map((r) => CorrectionRequestSerializer.toResponse(r));
  }
}
