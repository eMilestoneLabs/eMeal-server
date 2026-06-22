import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { UsersRepository } from './repositories/users.repository';
import { UserSerializer } from './serializers/user.serializer';
import { UpdateUserDto } from './dto/update-user.dto';
import { StorageService } from '../../storage/storage.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly storage: StorageService,
  ) {}

  /**
   * Additive: when an avatar arrives as a base64 data URI, upload it to object
   * storage (MinIO) and return the public URL, deleting the previous avatar
   * object (single current file per user). A value that is already a URL, or
   * null/undefined, passes through unchanged. Falls back to the previous avatar
   * if storage is unconfigured/unavailable so a profile edit never hard-fails.
   */
  private async resolveAvatarUrl(
    userId: string,
    organizationId: string | null,
    incoming: string | undefined,
    previous: string | null,
  ): Promise<string | undefined> {
    if (!incoming || !incoming.startsWith('data:image')) return incoming;
    const m = /^data:(image\/(?:jpeg|png));base64,(.+)$/s.exec(incoming);
    if (!m) return incoming;
    try {
      const mime = m[1] as 'image/jpeg' | 'image/png';
      const buffer = Buffer.from(m[2], 'base64');
      const url = await this.storage.uploadAvatar(
        organizationId ?? 'org',
        userId,
        buffer,
        mime,
      );
      const prevKey = this.storage.keyFromUrl(previous);
      if (prevKey) await this.storage.deleteImage(prevKey);
      return url;
    } catch {
      return previous ?? undefined;
    }
  }

  async getMe(userId: string) {
    // Additive: auto-deactivate vacation mode if the approved vacation has
    // ended (expiry) — so the flag flips OFF on next load, no restart/cron.
    await this.usersRepo.syncVacationExpiry(userId);
    const user = await this.usersRepo.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return UserSerializer.toResponse(user);
  }

  async updateMe(userId: string, dto: UpdateUserDto) {
    const user = await this.usersRepo.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    // Check for email/phone conflicts if updating
    if (dto.email && dto.email !== user.email) {
      const exists = await this.usersRepo.existsByEmail(dto.email);
      if (exists) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { email: 'Email already in use' },
        });
      }
    }
    if (dto.phone && dto.phone !== user.phone) {
      const exists = await this.usersRepo.existsByPhone(dto.phone);
      if (exists) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { phone: 'Phone number already in use' },
        });
      }
    }

    // Additive: a base64 data-URI avatar is uploaded to MinIO and stored as a
    // URL (single current file per user; previous object deleted). Already-URL
    // or null values pass through unchanged.
    const resolvedAvatarUrl = await this.resolveAvatarUrl(
      userId,
      (user as { organizationId?: string | null }).organizationId ?? null,
      dto.avatarUrl,
      user.avatarUrl,
    );

    const updated = await this.usersRepo.update(userId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.email !== undefined && { email: dto.email }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.avatarUrl !== undefined && { avatarUrl: resolvedAvatarUrl }),
      ...(dto.gender !== undefined && { gender: dto.gender }),
      ...(dto.age !== undefined && { age: dto.age }),
      ...(dto.isVacationMode !== undefined && { isVacationMode: dto.isVacationMode }),
      ...(dto.isDefaultAttendance !== undefined && { isDefaultAttendance: dto.isDefaultAttendance }),
      ...(dto.remindersEnabled !== undefined && { remindersEnabled: dto.remindersEnabled }),
      ...(dto.loginPreference !== undefined && { loginPreference: dto.loginPreference }),
    });

    return UserSerializer.toResponse(updated);
  }

  async setVacationMode(userId: string, enabled: boolean) {
    const user = await this.usersRepo.update(userId, { isVacationMode: enabled });
    return {
      isVacationMode: user.isVacationMode,
      message: enabled ? 'Vacation mode enabled' : 'Vacation mode disabled',
    };
  }

  async setDefaultAttendance(userId: string, enabled: boolean) {
    const user = await this.usersRepo.update(userId, { isDefaultAttendance: enabled });
    return {
      isDefaultAttendance: user.isDefaultAttendance,
      message: enabled
        ? 'Default attendance mode enabled'
        : 'Default attendance mode disabled',
    };
  }

  async updateFcmToken(userId: string, token: string) {
    await this.usersRepo.update(userId, { fcmToken: token });
    return { message: 'FCM token updated' };
  }
  async listByOrg(organizationId: string, params: { page: number; limit: number }) {
    const page = Math.max(1, params.page);
    const limit = Math.min(100, Math.max(1, params.limit));
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      this.usersRepo.findByOrg(organizationId, skip, limit),
      this.usersRepo.countByOrg(organizationId),
    ]);
    return {
      data: users.map(UserSerializer.toResponse),
      total,
      page,
      limit,
    };
  }

  async removeUser(userId: string, organizationId: string) {
    const user = await this.usersRepo.findById(userId);
    if (!user || user.organizationId !== organizationId) {
      throw new NotFoundException('User not found');
    }
    await this.usersRepo.update(userId, { isActive: false });
    return { message: 'User removed successfully' };
  }

}
