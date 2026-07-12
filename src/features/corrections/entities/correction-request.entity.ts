/**
 * AttendanceCorrectionRequestEntity — domain model for Module 33 (FR-ACR-*).
 *
 * requestType: claim_present | correct_to_absent | fix_preference |
 *              dispute_charge (SRS Module 03 COR-004: correct_to_skip REMOVED)
 * status:      pending | approved | rejected | expired | cancelled
 * sourceChannel: member (SRS Module 03 ATT-004: the admin_prompt override
 *                channel has been removed — corrections are member-initiated)
 */
export class CorrectionRequestEntity {
  id: string;
  organizationId: string;
  groupId: string;
  userId: string;
  /** Canonical display name resolved at read time (FR-NAME-001). */
  userName: string | null;
  mealId: string;
  /** Meal label resolved at read time (displayName ?? name). */
  mealName: string | null;
  attendanceDate: Date;

  requestType: string;
  requestedStatus: string | null;
  requestedPreference: string | null;
  /** ATT-004/COR-006: member-submitted selection set (same shape as marking). */
  requestedSelections: unknown | null;
  reason: string | null;
  evidenceUrl: string | null;

  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  sourceChannel: string;
  resultRecordId: string | null;

  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;

  constructor(partial: CorrectionRequestEntity) {
    Object.assign(this, partial);
  }
}
