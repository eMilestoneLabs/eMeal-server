/**
 * VacationRequestEntity — domain shape decoupled from the Prisma model.
 */
export class VacationRequestEntity {
  id: string;
  organizationId: string;
  groupId: string | null;
  userId: string;
  userName: string | null;
  startDate: Date;
  endDate: Date;
  // FR-VACX-003 (Pass 11): optional meal-granular boundaries (null = whole day).
  startSlotKey: string | null;
  endSlotKey: string | null;
  reason: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: Partial<VacationRequestEntity>) {
    Object.assign(this, data);
  }
}
