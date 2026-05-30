import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationEntity } from '../entities/organization.entity';

/**
 * OrganizationsRepository — all DB queries for Organization model.
 * Repository owns: query composition, org isolation, pagination.
 * Service owns: business logic, validation.
 */
@Injectable()
export class OrganizationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any): OrganizationEntity {
    return new OrganizationEntity(raw);
  }

  async findById(id: string): Promise<OrganizationEntity | null> {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    return org ? this.toEntity(org) : null;
  }

  async findBySlug(slug: string): Promise<OrganizationEntity | null> {
    const org = await this.prisma.organization.findUnique({ where: { slug } });
    return org ? this.toEntity(org) : null;
  }

  async create(data: {
    name: string;
    slug: string;
    timezone?: string;
    logoUrl?: string;
  }): Promise<OrganizationEntity> {
    const org = await this.prisma.organization.create({ data });
    return this.toEntity(org);
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      slug: string;
      logoUrl: string;
      timezone: string;
      isActive: boolean;
    }>,
  ): Promise<OrganizationEntity> {
    const org = await this.prisma.organization.update({ where: { id }, data });
    return this.toEntity(org);
  }

  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const count = await this.prisma.organization.count({
      where: {
        slug,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    return count > 0;
  }

  async countMembers(organizationId: string): Promise<number> {
    return this.prisma.user.count({ where: { organizationId, isActive: true } });
  }
}
