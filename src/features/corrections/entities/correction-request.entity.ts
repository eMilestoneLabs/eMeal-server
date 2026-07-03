/**
 * AttendanceCorrectionRequestEntity — domain model for Module 33 (FR-ACR-*).
 *
 * requestType: claim_present | correct_to_absent | correct_to_skip |
 *              fix_preference | dispute_charge
 * status:      pending | approved | rejected | expired | cancelled
 * sourceChannel: member | admin_prompt (FR-OVR-020 member confirmation)
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
