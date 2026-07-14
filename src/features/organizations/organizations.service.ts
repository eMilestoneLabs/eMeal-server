import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { OrganizationsRepository } from './repositories/organizations.repository';
import { OrganizationSerializer } from './serializers/organization.serializer';
import { AuditService } from '../../audit/audit.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly orgsRepo: OrganizationsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * POST /organizations
   * Create a new organization. Only admin roles may do this.
   * A user may only have one organization (enforced by JWT organizationId).
   */
  async createOrganization(
    actorId: string,
    actorRole: string,
    existingOrgId: string | null,
    dto: CreateOrganizationDto,
    requestId?: string,
  ) {
    // Guard: only admin roles can create organizations
    if (!ADMIN_ROLES.includes(actorRole as any)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: { role: 'Only admin roles can create organizations' },
      });
    }

    // If user already has an org, they cannot create another (MVP single-org rule)
    if (existingOrgId) {
      throw new ConflictException({
        message: 'Organization already exists',
        errors: { organizationId: 'You already belong to an organization' },
      });
    }

    // Generate slug from name if not provided
    const slug =
      dto.slug ??
      dto.name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');

    const slugTaken = await this.orgsRepo.slugExists(slug);
    if (slugTaken) {
      throw new ConflictException({
        message: 'Validation failed',
        errors: { slug: 'An organization with this name already exists' },
      });
    }

    const org = await this.orgsRepo.create({
      name: dto.name,
      slug,
      timezone: dto.timezone ?? 'Asia/Kolkata',
      logoUrl: dto.logoUrl,
    });

    this.audit.log({
      organizationId: org.id,
      actorId,
      targetId: org.id,
      targetType: 'Organization',
      action: 'create',
      requestId,
    });

    this.logger.log(`Organization created: ${org.slug} by user ${actorId}`);

    return OrganizationSerializer.toResponse(org);
  }

  /**
   * GET /organizations/me
   * Returns the current user's organization from JWT organizationId.
   */
  async getMyOrganization(organizationId: string | null) {
    if (!organizationId) {
      throw new NotFoundException({
        message: 'No organization found',
        errors: { organizationId: 'You are not associated with any organization' },
      });
    }

    const org = await this.orgsRepo.findById(organizationId);
    if (!org) {
      throw new NotFoundException({
        message: 'Organization not found',
        errors: { organizationId: 'Organization does not exist or has been removed' },
      });
    }

    return OrganizationSerializer.toResponse(org);
  }

  /**
   * PATCH /organizations/me
   * Update the current user's organization. Admin roles only.
   */
  async updateMyOrganization(
    actorId: string,
    actorRole: string,
    organizationId: string | null,
    dto: UpdateOrganizationDto,
    requestId?: string,
  ) {
    if (!organizationId) {
      throw new NotFoundException({
        message: 'No organization found',
        errors: { organizationId: 'You are not associated with any organization' },
      });
    }

    if (!ADMIN_ROLES.includes(actorRole as any)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: { role: 'Only admin roles can update organization settings' },
      });
    }

    // Slug conflict check (exclude current org)
    if (dto.slug) {
      const slugTaken = await this.orgsRepo.slugExists(dto.slug, organizationId);
      if (slugTaken) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { slug: 'This slug is already taken by another organization' },
        });
      }
    }

    // UNI-003 (uniqueness audit): organization RENAME validates the same
    // normalized-name uniqueness as signup — names are globally unique on the
    // normalized slug ("ABC Hostel" ≡ "abc  hostel!!"). When the caller renames
    // without supplying an explicit slug, the slug is re-derived from the new
    // name (keeping the name ≡ slug invariant) and checked excluding self, so
    // a rename can never silently collide with another organization.
    let derivedSlug: string | undefined;
    if (dto.name !== undefined && !dto.slug) {
      const current = await this.orgsRepo.findById(organizationId);
      if (current && dto.name.trim() !== current.name) {
        derivedSlug = dto.name
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '')
          .replace(/-+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!derivedSlug) {
          throw new BadRequestException({
            message: 'Validation failed',
            errors: { name: 'Enter a valid organization name' },
          });
        }
        if (await this.orgsRepo.slugExists(derivedSlug, organizationId)) {
          throw new ConflictException({
            message: 'Validation failed',
            errors: {
              name: 'This organization name is already taken. Please choose another.',
            },
          });
        }
      }
    }

    const updateData: any = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.slug !== undefined) updateData.slug = dto.slug;
    else if (derivedSlug !== undefined) updateData.slug = derivedSlug;
    if (dto.logoUrl !== undefined) updateData.logoUrl = dto.logoUrl;
    if (dto.timezone !== undefined) updateData.timezone = dto.timezone;
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;

    const org = await this.orgsRepo.update(organizationId, updateData);

    this.audit.log({
      organizationId,
      actorId,
      targetId: organizationId,
      targetType: 'Organization',
      action: 'update',
      metadata: { fields: Object.keys(updateData) },
      requestId,
    });

    return OrganizationSerializer.toResponse(org);
  }
}
