/**
 * Organization domain entity.
 * Sits between Prisma model and API DTO — never expose Prisma model directly.
 */
export class OrganizationEntity {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  planTier: string;
  timezone: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<OrganizationEntity>) {
    Object.assign(this, partial);
    this.logoUrl = this.logoUrl ?? null;
    this.planTier = this.planTier ?? 'free';
    this.timezone = this.timezone ?? 'Asia/Kolkata';
  }
}
