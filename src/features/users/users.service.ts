import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  Optional,
  Logger,
} from '@nestjs/common';
import { UsersRepository } from './repositories/users.repository';
import { UserSerializer } from './serializers/user.serializer';
import { UpdateUserDto } from './dto/update-user.dto';
import { StorageService } from '../../storage/storage.service';
import { AuditService } from '../../audit/audit.service';
import { QueueService } from '../../queue/queue.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly storage: StorageService,
    // Pass 11 (FR-VACX-007/LOOP-041): audit + notify on vacation changes.
    // Optional so existing TestingModules keep working unchanged. Explicit
    // @Inject: `Class | null` erases design:paramtypes (Pass 7 gotcha).
    @Optional()
    @Inject(AuditService)
    private readonly audit: AuditService | null = null,
    @Optional()
    @Inject(QueueService)
    private readonly queue: QueueService | null = null,
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

    // SRS Module 01 (AUTH-012/014): Mobile login preference is only meaningful
    // when a mobile number is on file — reject the switch otherwise.
    if (
      dto.loginPreference === 'mobile' &&
      !(dto.phone ?? user.phone)
    ) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: {
          loginPreference:
            'Add a mobile number before choosing Mobile as your login preference',
        },
      });
    }

    // Pass 11 (FR-VACX-001) parity: PATCH /users/me previously wrote
    // isVacationMode UNGUARDED, silently bypassing the approval workflow that
    // the dedicated vacation endpoint enforces. Turning vacation ON via
    // profile update now applies the same self-service guard; turning OFF
    // (early return) stays always allowed.
    if (dto.isVacationMode === true && user.isVacationMode !== true) {
      const needsApproval =
        await this.usersRepo.vacationRequiresApproval(userId);
      if (needsApproval) {
        throw new UnprocessableEntityException({
          message:
            'Your group requires admin approval for vacation — submit a vacation request instead',
          code: 'VACATION_REQUIRES_APPROVAL',
          errors: { isVacationMode: 'Create a dated vacation request for approval' },
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

  /**
   * Pass 11 (FR-VACX-001/007, LOOP-041).
   *   • Self-service: when any of the member's groups sets
   *     `vacationRequiresApproval`, the instant toggle is refused with a
   *     machine code — a dated VacationRequest is the approval path.
   *   • Admin-on-behalf: allowed (the admin IS the approver), but ALWAYS
   *     audited and the member is notified so a forced vacation can never
   *     silently deny meals (LOOP-041) — the member can contest.
   */
  async setVacationMode(
    userId: string,
    enabled: boolean,
    actor?: { id: string; organizationId?: string | null },
    requestId?: string,
  ) {
    const isSelf = !actor || actor.id === userId;

    if (isSelf && enabled) {
      const needsApproval = await this.usersRepo.vacationRequiresApproval(userId);
      if (needsApproval) {
        throw new UnprocessableEntityException({
          message:
            'Your group requires admin approval for vacation — submit a vacation request instead',
          code: 'VACATION_REQUIRES_APPROVAL',
          errors: { enabled: 'Create a dated vacation request for approval' },
        });
      }
    }

    const user = await this.usersRepo.update(userId, { isVacationMode: enabled });

    if (!isSelf && actor) {
      if (actor.organizationId) {
        this.audit?.log({
          organizationId: actor.organizationId,
          actorId: actor.id,
          targetId: userId,
          targetType: 'User',
          action: 'update',
          metadata: { isVacationMode: enabled, adminForced: true },
          requestId,
        });
      }

      // LOOP-041: never a silent admin-forced vacation.
      void this.usersRepo
        .getPushTarget(userId)
        .then((t) =>
          t && this.queue && t.organizationId
            ? this.queue.enqueueBatchPush({
                organizationId: t.organizationId,
                recipients: [{ userId: t.userId, fcmToken: t.fcmToken }],
                title: enabled
                  ? 'Vacation mode turned ON by your admin'
                  : 'Vacation mode turned OFF by your admin',
                body: enabled
                  ? 'You are marked on vacation and excluded from meals. Not right? You can turn it off in Settings or contact your admin.'
                  : 'Your vacation was ended by your admin — meal tracking has resumed.',
                route: '/settings',
                data: { type: 'vacation_admin_forced', enabled: String(enabled) },
              })
            : undefined,
        )
        .catch((err) =>
          this.logger.warn(`vacation push failed: ${(err as Error).message}`),
        );
    }

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

  /**
   * Pass 14 (FR-DEL-011 / FR-DLC-002/003, LOOP-080, SC-082) — self-service
   * account deletion. Revokes every session, soft-removes memberships, and
   * anonymizes PII in place; attendance, billing and audit history required
   * for group reporting/financial integrity is RETAINED (the user row
   * survives as "Deleted User"). Owed/consumed charges can never be erased
   * by deleting an account. Distinct from admin member-removal (FR-DEL-012).
   */
  async deleteMyAccount(
    userId: string,
    dto: { password?: string },
    requestId?: string,
  ) {
    const user = await this.usersRepo.findAuthById(userId);
    if (!user || !user.isActive) {
      throw new NotFoundException('User not found');
    }

    // Accounts with a password must present it; OTP-only accounts rely on
    // the DTO's mandatory confirm phrase (validated before we get here).
    if (user.passwordHash) {
      const bcrypt = await import('bcryptjs');
      const ok = await bcrypt.compare(dto.password ?? '', user.passwordHash);
      if (!ok) {
        throw new UnprocessableEntityException({
          message: 'Incorrect password',
          errors: { password: 'Enter your current password to delete the account' },
        });
      }
    }

    const avatarKey = this.storage.keyFromUrl(user.avatarUrl);
    await this.usersRepo.deleteAccount(userId);

    // Best-effort PII cleanup of the stored avatar object; never blocks.
    if (avatarKey) {
      this.storage
        .deleteImage(avatarKey)
        .catch((err) =>
          this.logger.warn(`avatar purge failed: ${(err as Error).message}`),
        );
    }

    this.audit?.log({
      organizationId: user.organizationId ?? undefined,
      actorId: userId,
      targetId: userId,
      targetType: 'User',
      action: 'delete',
      metadata: {
        selfDeletion: true,
        sessionsRevoked: true,
        membershipsSoftRemoved: true,
        piiAnonymized: true,
        financialRecordsRetained: true,
      },
      requestId,
    });

    return {
      message:
        'Account deleted. Your personal data has been anonymized; attendance and billing history required for group records is retained per policy.',
    };
  }

}
