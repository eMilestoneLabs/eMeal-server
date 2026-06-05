import { OrganizationSerializer } from '../serializers/organization.serializer';
import { OrganizationEntity } from '../entities/organization.entity';

describe('OrganizationSerializer', () => {
  const mockOrg = new OrganizationEntity({
    id: 'org_01',
    name: 'Test Hostel',
    slug: 'test-hostel',
    logoUrl: null,
    planTier: 'free',
    timezone: 'Asia/Kolkata',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  it('produces all expected fields', () => {
    const response = OrganizationSerializer.toResponse(mockOrg);
    expect(response).toMatchObject({
      id: 'org_01',
      name: 'Test Hostel',
      slug: 'test-hostel',
      logoUrl: null,
      planTier: 'free',
      timezone: 'Asia/Kolkata',
      isActive: true,
    });
  });

  it('serializes createdAt as ISO string', () => {
    const response = OrganizationSerializer.toResponse(mockOrg);
    expect(response.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never exposes internal Prisma fields', () => {
    const response = OrganizationSerializer.toResponse(mockOrg);
    // updatedAt not included in response (internal)
    expect(response).not.toHaveProperty('updatedAt');
  });

  it('handles null logoUrl correctly', () => {
    const response = OrganizationSerializer.toResponse(mockOrg);
    expect(response.logoUrl).toBeNull();
  });
});
