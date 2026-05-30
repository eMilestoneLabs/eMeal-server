import { OrganizationEntity } from '../entities/organization.entity';

/**
 * Organization response serializer.
 * Converts domain entity → exact API JSON shape.
 * Additive-safe: only add fields, never remove or rename.
 */
export class OrganizationSerializer {
  static toResponse(org: OrganizationEntity): Record<string, unknown> {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoUrl ?? null,
      planTier: org.planTier,
      timezone: org.timezone,
      isActive: org.isActive,
      createdAt: org.createdAt.toISOString(),
    };
  }
}
